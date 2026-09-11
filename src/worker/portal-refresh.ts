import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import {
  CaseType,
  PortalRefreshStatus,
  SyncEntityType,
} from "../generated/prisma/enums.js";
import {
  AIRTABLE_TABLE_IDS,
  DEVICE_FIELD_IDS,
  HOSPITAL_FIELD_IDS,
  INSPECTION_FIELD_IDS,
  SERVICE_ORDER_FIELD_IDS,
  TASK_FIELD_IDS,
} from "../airtable/field-ids.js";
import { AirtableRequestError } from "../airtable/client.js";
import { mapDevice } from "../airtable/device.js";
import { mapHospital } from "../airtable/hospital.js";
import { mapInspection, mapServiceOrder } from "../airtable/mappers.js";
import { mapTask } from "../airtable/task.js";
import type { AirtableIncrementalSource, AirtableRecord } from "../airtable/types.js";
import type { CommunicationEventStore } from "./communication-event.js";
import type { IncrementalStore } from "./incremental-store.js";
import { syncSingleCaseRecord } from "./incremental-sync.js";
import type { DeviceSyncStore } from "./device-sync.js";
import { syncSingleDeviceRecord } from "./device-sync.js";
import type { TaskSyncStore } from "./task-sync.js";
import { syncSingleTaskRecord } from "./task-sync.js";

const DEFAULT_LEASE_MS = 5 * 60_000;

export type PortalRefreshWorkItem = {
  id: string;
  leaseToken: string;
  sourceHospitalRecordId: string;
  serviceOrderRecordIds: string[];
  inspectionRecordIds: string[];
  deviceRecordIds: string[];
  taskRecordIds: string[];
};

export interface PortalRefreshWorkerStore {
  claimNext(now: Date, leaseToken: string, leaseExpiresAt: Date): Promise<PortalRefreshWorkItem | null>;
  extendLease(id: string, leaseToken: string, leaseExpiresAt: Date): Promise<boolean>;
  markSucceeded(id: string, leaseToken: string, completedAt: Date): Promise<boolean>;
  markFailed(id: string, leaseToken: string, completedAt: Date, errorCode: string): Promise<boolean>;
  isCaseInHospital(
    caseType: CaseType,
    recordId: string,
    sourceHospitalRecordId: string,
  ): Promise<boolean>;
  deactivateCase(
    caseType: CaseType,
    recordId: string,
    sourceHospitalRecordId: string,
  ): Promise<boolean>;
  deactivateDevice(recordId: string, sourceHospitalRecordId: string): Promise<boolean>;
  deactivateTask(recordId: string, sourceHospitalRecordId: string): Promise<boolean>;
}

type ClaimedRefreshRow = {
  id: string;
  leaseToken: string;
  sourceHospitalRecordId: string;
  serviceOrderRecordIds: unknown;
  inspectionRecordIds: unknown;
  deviceRecordIds: unknown;
  taskRecordIds: unknown;
};

export class PrismaPortalRefreshWorkerStore implements PortalRefreshWorkerStore {
  constructor(private readonly prisma: PrismaClient) {}

  async claimNext(
    now: Date,
    leaseToken: string,
    leaseExpiresAt: Date,
  ): Promise<PortalRefreshWorkItem | null> {
    const rows = await this.prisma.$queryRaw<ClaimedRefreshRow[]>(Prisma.sql`
      UPDATE "PortalRefreshRequest" refresh_request
      SET status = 'RUNNING'::"PortalRefreshStatus",
          "startedAt" = ${now},
          "completedAt" = NULL,
          "errorCode" = NULL,
          "attemptCount" = refresh_request."attemptCount" + 1,
          "leaseToken" = ${leaseToken},
          "leaseExpiresAt" = ${leaseExpiresAt}
      FROM (
        SELECT id FROM "PortalRefreshRequest"
        WHERE status = 'PENDING'::"PortalRefreshStatus"
           OR (status = 'RUNNING'::"PortalRefreshStatus" AND "leaseExpiresAt" < ${now})
        ORDER BY "requestedAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      ) candidate
      WHERE refresh_request.id = candidate.id
      RETURNING refresh_request.id,
        refresh_request."leaseToken",
        refresh_request."sourceHospitalRecordId",
        refresh_request."serviceOrderRecordIds",
        refresh_request."inspectionRecordIds",
        refresh_request."deviceRecordIds",
        refresh_request."taskRecordIds"
    `);
    const row = rows[0];
    return row ? {
      id: row.id,
      leaseToken: row.leaseToken,
      sourceHospitalRecordId: row.sourceHospitalRecordId,
      serviceOrderRecordIds: stringArray(row.serviceOrderRecordIds),
      inspectionRecordIds: stringArray(row.inspectionRecordIds),
      deviceRecordIds: stringArray(row.deviceRecordIds),
      taskRecordIds: stringArray(row.taskRecordIds),
    } : null;
  }

  async extendLease(id: string, leaseToken: string, leaseExpiresAt: Date): Promise<boolean> {
    const result = await this.prisma.portalRefreshRequest.updateMany({
      where: { id, status: PortalRefreshStatus.RUNNING, leaseToken },
      data: { leaseExpiresAt },
    });
    return result.count === 1;
  }

  async markSucceeded(id: string, leaseToken: string, completedAt: Date): Promise<boolean> {
    const result = await this.prisma.portalRefreshRequest.updateMany({
      where: { id, status: PortalRefreshStatus.RUNNING, leaseToken },
      data: {
        status: PortalRefreshStatus.SUCCEEDED,
        completedAt,
        activeKey: null,
        leaseToken: null,
        leaseExpiresAt: null,
        errorCode: null,
      },
    });
    return result.count === 1;
  }

  async markFailed(
    id: string,
    leaseToken: string,
    completedAt: Date,
    errorCode: string,
  ): Promise<boolean> {
    const result = await this.prisma.portalRefreshRequest.updateMany({
      where: { id, status: PortalRefreshStatus.RUNNING, leaseToken },
      data: {
        status: PortalRefreshStatus.FAILED,
        completedAt,
        activeKey: null,
        leaseToken: null,
        leaseExpiresAt: null,
        errorCode,
      },
    });
    return result.count === 1;
  }

  async isCaseInHospital(
    caseType: CaseType,
    recordId: string,
    sourceHospitalRecordId: string,
  ): Promise<boolean> {
    return await this.prisma.trackedCase.count({
      where: {
        caseType,
        airtableRecordId: recordId,
        sourceHospitalRecordId,
        active: true,
      },
    }) === 1;
  }

  async deactivateCase(
    caseType: CaseType,
    recordId: string,
    sourceHospitalRecordId: string,
  ): Promise<boolean> {
    const result = await this.prisma.trackedCase.updateMany({
      where: {
        caseType,
        airtableRecordId: recordId,
        sourceHospitalRecordId,
        active: true,
      },
      data: { active: false },
    });
    return result.count > 0;
  }

  async deactivateDevice(recordId: string, sourceHospitalRecordId: string): Promise<boolean> {
    const result = await this.prisma.trackedDevice.updateMany({
      where: { airtableRecordId: recordId, sourceHospitalRecordId, active: true },
      data: { active: false },
    });
    return result.count > 0;
  }

  async deactivateTask(recordId: string, sourceHospitalRecordId: string): Promise<boolean> {
    const result = await this.prisma.trackedTask.updateMany({
      where: { airtableRecordId: recordId, sourceHospitalRecordId, active: true },
      data: { active: false },
    });
    return result.count > 0;
  }
}

export async function runPortalRefreshWorkerOnce(dependencies: {
  store: PortalRefreshWorkerStore;
  airtable: AirtableIncrementalSource;
  incrementalStore: IncrementalStore;
  deviceStore: Pick<DeviceSyncStore, "upsert">;
  taskStore: Pick<TaskSyncStore, "upsertTask">;
  communicationStore: CommunicationEventStore;
  quietMinutes: number;
  now?: () => Date;
  leaseMs?: number;
  log?: (message: string) => void;
}): Promise<boolean> {
  const now = dependencies.now ?? (() => new Date());
  const leaseMs = dependencies.leaseMs ?? DEFAULT_LEASE_MS;
  const leaseToken = randomUUID();
  const claimed = await dependencies.store.claimNext(
    now(),
    leaseToken,
    new Date(now().getTime() + leaseMs),
  );
  if (!claimed) return false;

  const renewLease = async () => {
    if (!await dependencies.store.extendLease(
      claimed.id,
      claimed.leaseToken,
      new Date(now().getTime() + leaseMs),
    )) throw new Error("PORTAL_REFRESH_LEASE_LOST");
  };

  try {
    const serviceCommunicationEnabled = await dependencies.communicationStore
      .isBaselineCompleted("SERVICE_ORDER");
    const taskCommunicationEnabled = await dependencies.communicationStore
      .isBaselineCompleted("TASK");
    const deviceRecordIds = new Set(claimed.deviceRecordIds);
    const currentHospitalInspectionIds = claimed.inspectionRecordIds.length === 0
      ? null
      : new Set(mapHospital(await dependencies.airtable.fetchRecord(
          AIRTABLE_TABLE_IDS.hospitals,
          claimed.sourceHospitalRecordId,
          HOSPITAL_FIELD_IDS,
        )).linkedInspectionRecordIds);
    await syncRecords(claimed.taskRecordIds, async (recordId) => {
      const record = await dependencies.airtable.fetchRecord(
        AIRTABLE_TABLE_IDS.tasks, recordId, TASK_FIELD_IDS,
      );
      if (mapTask(record).sourceHospitalRecordId !== claimed.sourceHospitalRecordId) {
        await dependencies.store.deactivateTask(recordId, claimed.sourceHospitalRecordId);
        return;
      }
      await syncSingleTaskRecord({
        record,
        store: dependencies.taskStore,
        communicationStore: dependencies.communicationStore,
        communicationBaseline: taskCommunicationEnabled,
        detectedAt: now(),
        ...(dependencies.log ? { log: dependencies.log } : {}),
      });
    }, (recordId) => dependencies.store.deactivateTask(
      recordId,
      claimed.sourceHospitalRecordId,
    ), renewLease, dependencies.log);

    await syncRecords(claimed.serviceOrderRecordIds, async (recordId) => {
      const record = await dependencies.airtable.fetchRecord(
        AIRTABLE_TABLE_IDS.serviceOrders, recordId, SERVICE_ORDER_FIELD_IDS,
      );
      const mapped = mapServiceOrder(record);
      if (mapped.sourceHospitalRecordId !== claimed.sourceHospitalRecordId) {
        await dependencies.store.deactivateCase(
          CaseType.SERVICE_ORDER,
          recordId,
          claimed.sourceHospitalRecordId,
        );
        return;
      }
      mapped.deviceAirtableIds.forEach((id) => deviceRecordIds.add(id));
      await syncSingleCaseRecord({
        entityType: SyncEntityType.SERVICE_ORDER,
        record,
        airtable: dependencies.airtable,
        store: dependencies.incrementalStore,
        quietMinutes: dependencies.quietMinutes,
        legacyNotificationsEnabled: false,
        communicationStore: dependencies.communicationStore,
        serviceCommunicationEnabled,
        detectedAt: now(),
        ...(dependencies.log ? { log: dependencies.log } : {}),
      });
    }, (recordId) => dependencies.store.deactivateCase(
      CaseType.SERVICE_ORDER,
      recordId,
      claimed.sourceHospitalRecordId,
    ), renewLease, dependencies.log);

    await syncRecords(claimed.inspectionRecordIds, async (recordId) => {
      if (!currentHospitalInspectionIds?.has(recordId)) {
        await dependencies.store.deactivateCase(
          CaseType.INSPECTION,
          recordId,
          claimed.sourceHospitalRecordId,
        );
        return;
      }
      if (!await dependencies.store.isCaseInHospital(
        CaseType.INSPECTION,
        recordId,
        claimed.sourceHospitalRecordId,
      )) return;
      const record = await dependencies.airtable.fetchRecord(
        AIRTABLE_TABLE_IDS.inspections, recordId, INSPECTION_FIELD_IDS,
      );
      mapInspection(record).deviceAirtableIds.forEach((id) => deviceRecordIds.add(id));
      await syncSingleCaseRecord({
        entityType: SyncEntityType.INSPECTION,
        record,
        airtable: dependencies.airtable,
        store: dependencies.incrementalStore,
        quietMinutes: dependencies.quietMinutes,
        legacyNotificationsEnabled: false,
        communicationStore: dependencies.communicationStore,
        serviceCommunicationEnabled,
        detectedAt: now(),
        ...(dependencies.log ? { log: dependencies.log } : {}),
      });
    }, (recordId) => dependencies.store.deactivateCase(
      CaseType.INSPECTION,
      recordId,
      claimed.sourceHospitalRecordId,
    ), renewLease, dependencies.log);

    await syncRecords([...deviceRecordIds], async (recordId) => {
      const record = await dependencies.airtable.fetchRecord(
        AIRTABLE_TABLE_IDS.devices, recordId, DEVICE_FIELD_IDS,
      );
      if (mapDevice(record).sourceHospitalRecordId !== claimed.sourceHospitalRecordId) {
        await dependencies.store.deactivateDevice(recordId, claimed.sourceHospitalRecordId);
        return;
      }
      await syncSingleDeviceRecord({ record, store: dependencies.deviceStore, seenAt: now() });
    }, (recordId) => dependencies.store.deactivateDevice(
      recordId,
      claimed.sourceHospitalRecordId,
    ), renewLease, dependencies.log);

    if (!await dependencies.store.markSucceeded(claimed.id, claimed.leaseToken, now())) {
      throw new Error("PORTAL_REFRESH_LEASE_LOST");
    }
    dependencies.log?.(`PORTAL_REFRESH_SUCCEEDED requestId=${claimed.id}`);
  } catch (error: unknown) {
    await dependencies.store.markFailed(
      claimed.id,
      claimed.leaseToken,
      now(),
      error instanceof Error && error.message === "PORTAL_REFRESH_LEASE_LOST"
        ? "LEASE_LOST"
        : "SYNC_FAILED",
    ).catch(() => false);
    dependencies.log?.(`PORTAL_REFRESH_FAILED requestId=${claimed.id}`);
  }
  return true;
}

async function syncRecords(
  recordIds: readonly string[],
  sync: (recordId: string) => Promise<void>,
  onMissing: (recordId: string) => Promise<boolean>,
  renewLease: () => Promise<void>,
  log?: (message: string) => void,
): Promise<void> {
  for (const recordId of [...new Set(recordIds)]) {
    try {
      await sync(recordId);
    } catch (error: unknown) {
      if (error instanceof AirtableRequestError && error.httpStatus === 404) {
        await onMissing(recordId);
        log?.(`PORTAL_REFRESH_RECORD_MISSING recordId=${recordId}`);
      } else {
        throw error;
      }
    }
    await renewLease();
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}
