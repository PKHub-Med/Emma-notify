import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import { CaseType, SyncEntityType, SyncStatus } from "../generated/prisma/enums.js";
import { isDeepStrictEqual } from "node:util";
import {
  AIRTABLE_TABLE_IDS,
  DEVICE_FIELD_IDS,
  DEVICE_FIELDS,
} from "../airtable/field-ids.js";
import { mapDevice, type MappedDevice } from "../airtable/device.js";
import type {
  AirtableIncrementalSource,
  AirtableListOptions,
  AirtableRecord,
  AirtableRequestMetrics,
} from "../airtable/types.js";
import { synchronizeCaseDeviceRelations } from "./baseline-store.js";

export type DeviceSyncMode = "BASELINE" | "INCREMENTAL" | "RECONCILE";

export interface DeviceSyncStore {
  getCheckpoint(): Promise<{
    baselineCompletedAt: Date | null;
    lastSuccessfulSyncAt: Date | null;
  } | null>;
  markRunning(at: Date): Promise<void>;
  upsert(device: MappedDevice, seenAt: Date): Promise<void>;
  markSuccessful(at: Date, completeBaseline: boolean): Promise<void>;
  markFailed(at: Date): Promise<void>;
}

export class PrismaDeviceSyncStore implements DeviceSyncStore {
  constructor(private readonly prisma: PrismaClient) {}

  getCheckpoint() {
    return this.prisma.syncState.findUnique({
      where: {
        source_entityType: { source: "AIRTABLE", entityType: SyncEntityType.DEVICE },
      },
      select: { baselineCompletedAt: true, lastSuccessfulSyncAt: true },
    });
  }

  async markRunning(at: Date): Promise<void> {
    await this.prisma.syncState.upsert({
      where: {
        source_entityType: { source: "AIRTABLE", entityType: SyncEntityType.DEVICE },
      },
      create: {
        source: "AIRTABLE",
        entityType: SyncEntityType.DEVICE,
        status: SyncStatus.RUNNING,
        lastAttemptAt: at,
      },
      update: { status: SyncStatus.RUNNING, lastAttemptAt: at, lastError: null },
    });
  }

  async upsert(device: MappedDevice, seenAt: Date): Promise<void> {
    const snapshot = {
      ...device,
      sourceCreatedAt: device.sourceCreatedAt?.toISOString() ?? null,
      sourceModifiedAt: device.sourceModifiedAt?.toISOString() ?? null,
    } as Prisma.InputJsonObject;
    await this.prisma.$transaction(async (transaction) => {
      const current = await transaction.trackedDevice.findUnique({
        where: { airtableRecordId: device.airtableRecordId },
        select: { sourceSnapshot: true },
      });
      if (current && isDeepStrictEqual(current.sourceSnapshot, snapshot)) {
        await transaction.trackedDevice.update({
          where: { airtableRecordId: device.airtableRecordId },
          data: { lastSeenAt: seenAt },
        });
      } else {
        await transaction.trackedDevice.upsert({
          where: { airtableRecordId: device.airtableRecordId },
          create: { ...device, sourceSnapshot: snapshot, firstSeenAt: seenAt, lastSeenAt: seenAt },
          update: { ...device, sourceSnapshot: snapshot, lastSeenAt: seenAt },
        });
      }
      const affectedCases = await transaction.trackedCase.findMany({
        where: { devices: { some: { deviceAirtableId: device.airtableRecordId } } },
        select: {
          id: true,
          caseType: true,
          airtableRecordId: true,
          sourceHospitalRecordId: true,
          devices: { select: { deviceAirtableId: true } },
        },
      });
      for (const trackedCase of affectedCases) {
        await synchronizeCaseDeviceRelations(transaction, {
          trackedCaseId: trackedCase.id,
          caseType: trackedCase.caseType,
          sourceRecordId: trackedCase.airtableRecordId,
          directHospitalRecordId: trackedCase.caseType === CaseType.INSPECTION
            ? null
            : trackedCase.sourceHospitalRecordId,
          deviceAirtableIds: trackedCase.devices.map((item) => item.deviceAirtableId),
        });
      }
    });
  }

  async markSuccessful(at: Date, completeBaseline: boolean): Promise<void> {
    await this.prisma.syncState.update({
      where: {
        source_entityType: { source: "AIRTABLE", entityType: SyncEntityType.DEVICE },
      },
      data: {
        status: SyncStatus.IDLE,
        lastSuccessfulSyncAt: at,
        ...(completeBaseline ? { baselineCompletedAt: at } : {}),
        lastError: null,
      },
    });
  }

  async markFailed(at: Date): Promise<void> {
    await this.prisma.syncState.update({
      where: {
        source_entityType: { source: "AIRTABLE", entityType: SyncEntityType.DEVICE },
      },
      data: {
        status: SyncStatus.ERROR,
        lastAttemptAt: at,
        lastError: "Device synchronization failed",
      },
    });
  }
}

export async function runDeviceSync(dependencies: {
  airtable: AirtableIncrementalSource;
  store: DeviceSyncStore;
  requestedMode?: "AUTO" | "RECONCILE";
  overlapSeconds?: number;
  now?: () => Date;
  log?: (message: string) => void;
}): Promise<{
  mode: DeviceSyncMode;
  recordsFetched: number;
  pagesFetched: number;
  requestsMade: number;
  durationMs: number;
}> {
  const now = dependencies.now ?? (() => new Date());
  const startedAt = now();
  await dependencies.store.markRunning(startedAt);
  try {
    const checkpoint = await dependencies.store.getCheckpoint();
    const mode: DeviceSyncMode = dependencies.requestedMode === "RECONCILE"
      ? "RECONCILE"
      : checkpoint?.baselineCompletedAt ? "INCREMENTAL" : "BASELINE";
    const options = mode === "INCREMENTAL"
      ? { filterByFormula: buildDeviceIncrementalFormula(new Date(
          (checkpoint?.lastSuccessfulSyncAt ?? checkpoint!.baselineCompletedAt!).getTime() -
          (dependencies.overlapSeconds ?? 120) * 1_000,
        )) }
      : undefined;
    const measured = await fetchMeasured(
      dependencies.airtable,
      AIRTABLE_TABLE_IDS.devices,
      DEVICE_FIELD_IDS,
      options,
    );
    for (const record of measured.records) {
      await dependencies.store.upsert(mapDevice(record), now());
    }
    const completedAt = now();
    await dependencies.store.markSuccessful(completedAt, mode === "BASELINE");
    const stats = {
      mode,
      recordsFetched: measured.records.length,
      pagesFetched: measured.metrics.pagesFetched,
      requestsMade: measured.metrics.requestsMade,
      durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
    };
    dependencies.log?.(
      `AIRTABLE_SYNC_STATS entityType=DEVICE mode=${mode} ` +
      `recordsFetched=${stats.recordsFetched} pagesFetched=${stats.pagesFetched} ` +
      `requestsMade=${stats.requestsMade} durationMs=${stats.durationMs}`,
    );
    return stats;
  } catch (error: unknown) {
    await dependencies.store.markFailed(now()).catch(() => undefined);
    throw error;
  }
}

export const DEVICE_EDITABLE_FIELD_IDS = [
  DEVICE_FIELDS.name,
  DEVICE_FIELDS.manufacturer,
  DEVICE_FIELDS.model,
  DEVICE_FIELDS.serialNumber,
  DEVICE_FIELDS.inventoryNumber,
  DEVICE_FIELDS.location,
  DEVICE_FIELDS.hospitalLink,
  DEVICE_FIELDS.deviceStatus,
] as const;

export function buildDeviceIncrementalFormula(since: Date): string {
  return `IS_AFTER(LAST_MODIFIED_TIME(${DEVICE_EDITABLE_FIELD_IDS.map((id) =>
    `{${id}}`).join(",")}), DATETIME_PARSE('${since.toISOString()}'))`;
}

async function fetchMeasured(
  source: AirtableIncrementalSource,
  tableId: string,
  fieldIds: readonly string[],
  options?: AirtableListOptions,
): Promise<{ records: AirtableRecord[]; metrics: AirtableRequestMetrics }> {
  const measured = source as AirtableIncrementalSource & {
    fetchAllRecordsWithMetrics?: (
      tableId: string,
      fieldIds: readonly string[],
      options?: AirtableListOptions,
    ) => Promise<{ records: AirtableRecord[]; metrics: AirtableRequestMetrics }>;
  };
  if (measured.fetchAllRecordsWithMetrics) {
    return measured.fetchAllRecordsWithMetrics(tableId, fieldIds, options);
  }
  const before = metrics(source);
  const records = await source.fetchAllRecords(tableId, fieldIds, options);
  const after = metrics(source);
  return {
    records,
    metrics: {
      requestsMade: after.requestsMade - before.requestsMade,
      pagesFetched: after.pagesFetched - before.pagesFetched,
    },
  };
}

function metrics(source: AirtableIncrementalSource): AirtableRequestMetrics {
  const measured = source as AirtableIncrementalSource & {
    getRequestMetrics?: () => AirtableRequestMetrics;
  };
  return measured.getRequestMetrics?.() ?? { requestsMade: 0, pagesFetched: 0 };
}
