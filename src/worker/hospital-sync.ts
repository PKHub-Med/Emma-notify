import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import { CaseType, SyncEntityType, SyncStatus } from "../generated/prisma/enums.js";
import {
  AIRTABLE_TABLE_IDS,
  HOSPITAL_FIELD_IDS,
} from "../airtable/field-ids.js";
import { mapHospital, type MappedHospital } from "../airtable/hospital.js";
import type { AirtableRecordSource } from "../airtable/types.js";

export interface HospitalSyncStore {
  upsert(hospital: MappedHospital, seenAt: Date): Promise<void>;
  synchronizeInspectionScopes(
    index: InspectionHospitalScopeIndex,
    log?: (message: string) => void,
    recordIds?: readonly string[],
  ): Promise<InspectionHospitalScopeStats>;
  markRunning(at: Date): Promise<void>;
  markSuccessful(at: Date): Promise<void>;
  markFailed(at: Date): Promise<void>;
}

export class PrismaHospitalSyncStore implements HospitalSyncStore {
  constructor(private readonly prisma: PrismaClient | Prisma.TransactionClient) {}

  async upsert(hospital: MappedHospital, seenAt: Date): Promise<void> {
    const { linkedInspectionRecordIds: _linkedInspectionRecordIds, ...hospitalData } = hospital;
    const snapshot = {
      shortName: hospital.shortName,
      name: hospital.name,
      address: hospital.address,
    } as Prisma.InputJsonObject;
    await this.prisma.trackedHospital.upsert({
      where: { airtableRecordId: hospital.airtableRecordId },
      create: { ...hospitalData, sourceSnapshot: snapshot, lastSeenAt: seenAt, active: true },
      update: { ...hospitalData, sourceSnapshot: snapshot, lastSeenAt: seenAt, active: true },
    });
  }

  async synchronizeInspectionScopes(
    index: InspectionHospitalScopeIndex,
    log: (message: string) => void = console.warn,
    recordIds?: readonly string[],
  ): Promise<InspectionHospitalScopeStats> {
    return synchronizeInspectionHospitalScopes(this.prisma, index, log, recordIds);
  }

  async markRunning(at: Date): Promise<void> {
    await this.prisma.syncState.upsert({
      where: { source_entityType: { source: "AIRTABLE", entityType: SyncEntityType.HOSPITAL } },
      create: { source: "AIRTABLE", entityType: SyncEntityType.HOSPITAL, status: SyncStatus.RUNNING, lastAttemptAt: at },
      update: { status: SyncStatus.RUNNING, lastAttemptAt: at, lastError: null },
    });
  }

  async markSuccessful(at: Date): Promise<void> {
    await this.prisma.syncState.update({
      where: { source_entityType: { source: "AIRTABLE", entityType: SyncEntityType.HOSPITAL } },
      data: { status: SyncStatus.IDLE, lastSuccessfulSyncAt: at, baselineCompletedAt: at, lastError: null },
    });
  }

  async markFailed(at: Date): Promise<void> {
    await this.prisma.syncState.update({
      where: { source_entityType: { source: "AIRTABLE", entityType: SyncEntityType.HOSPITAL } },
      data: { status: SyncStatus.ERROR, lastAttemptAt: at, lastError: "Hospital synchronization failed" },
    });
  }
}

export async function runHospitalSync(dependencies: {
  airtable: AirtableRecordSource;
  store: HospitalSyncStore;
  now?: () => Date;
  log?: (message: string) => void;
}): Promise<{ recordsFetched: number; pagesFetched: number; requestsMade: number; durationMs: number }> {
  const now = dependencies.now ?? (() => new Date());
  const startedAt = now();
  const before = metrics(dependencies.airtable);
  await dependencies.store.markRunning(startedAt);
  try {
    const records = await dependencies.airtable.fetchAllRecords(
      AIRTABLE_TABLE_IDS.hospitals,
      HOSPITAL_FIELD_IDS,
    );
    const hospitals = records.map(mapHospital);
    for (const hospital of hospitals) {
      await dependencies.store.upsert(hospital, startedAt);
    }
    await dependencies.store.synchronizeInspectionScopes(
      buildInspectionHospitalScopeIndex(hospitals),
      dependencies.log,
    );
    const completedAt = now();
    await dependencies.store.markSuccessful(completedAt);
    const after = metrics(dependencies.airtable);
    const stats = {
      recordsFetched: records.length,
      pagesFetched: after.pagesFetched - before.pagesFetched,
      requestsMade: after.requestsMade - before.requestsMade,
      durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
    };
    dependencies.log?.(`AIRTABLE_SYNC_STATS entityType=HOSPITAL mode=RECONCILE recordsFetched=${stats.recordsFetched} pagesFetched=${stats.pagesFetched} requestsMade=${stats.requestsMade} durationMs=${stats.durationMs}`);
    return stats;
  } catch (error: unknown) {
    await dependencies.store.markFailed(now());
    throw error;
  }
}

export type InspectionHospitalScopeIndex = ReadonlyMap<string, ReadonlySet<string>>;

export type InspectionHospitalScopeStats = {
  scanned: number;
  repaired: number;
  unchanged: number;
  stillUnscoped: number;
  ambiguous: number;
};

export function buildInspectionHospitalScopeIndex(
  hospitals: readonly MappedHospital[],
): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const hospital of hospitals) {
    for (const inspectionRecordId of hospital.linkedInspectionRecordIds) {
      const hospitalIds = index.get(inspectionRecordId) ?? new Set<string>();
      hospitalIds.add(hospital.airtableRecordId);
      index.set(inspectionRecordId, hospitalIds);
    }
  }
  return index;
}

export async function synchronizeInspectionHospitalScopes(
  prisma: PrismaClient | Prisma.TransactionClient,
  index: InspectionHospitalScopeIndex,
  log: (message: string) => void = console.warn,
  recordIds?: readonly string[],
): Promise<InspectionHospitalScopeStats> {
  const scopedRecordIds = recordIds ? [...new Set(recordIds)] : undefined;
  const inspections = await prisma.trackedCase.findMany({
    where: {
      caseType: CaseType.INSPECTION,
      ...(scopedRecordIds ? { airtableRecordId: { in: scopedRecordIds } } : {}),
    },
    select: {
      id: true,
      airtableRecordId: true,
      sourceHospitalRecordId: true,
      devices: { select: { deviceAirtableId: true } },
    },
  });
  const deviceRecordIds = [...new Set(inspections.flatMap((inspection) =>
    (inspection.devices ?? []).map((device) => device.deviceAirtableId)))];
  const devices = deviceRecordIds.length > 0
    ? await prisma.trackedDevice.findMany({
        where: { airtableRecordId: { in: deviceRecordIds }, active: true },
        select: { airtableRecordId: true, sourceHospitalRecordId: true },
      })
    : [];
  const hospitalByDevice = new Map(devices.map((device) =>
    [device.airtableRecordId, device.sourceHospitalRecordId]));
  let repaired = 0;
  let unchanged = 0;
  let stillUnscoped = 0;
  let ambiguous = 0;

  for (const inspection of inspections) {
    const directHospitalIds = index.get(inspection.airtableRecordId) ?? new Set<string>();
    const deviceHospitalIds = new Set((inspection.devices ?? [])
      .map((device) => hospitalByDevice.get(device.deviceAirtableId) ?? null)
      .filter((value): value is string => Boolean(value)));
    const evidence = directHospitalIds.size > 0 ? directHospitalIds : deviceHospitalIds;
    const conflictingSources = directHospitalIds.size > 0 && deviceHospitalIds.size > 0 &&
      (directHospitalIds.size !== deviceHospitalIds.size ||
        [...directHospitalIds].some((hospitalId) => !deviceHospitalIds.has(hospitalId)));
    const inferredScope = !conflictingSources && evidence.size === 1
      ? evidence.values().next().value ?? null
      : null;
    const conflictsWithExisting = Boolean(
      inspection.sourceHospitalRecordId && inferredScope &&
      inspection.sourceHospitalRecordId !== inferredScope,
    );
    const desiredScope = conflictsWithExisting ? null : inferredScope;
    if (directHospitalIds.size === 0 && deviceHospitalIds.size === 0) {
      stillUnscoped += 1;
      log(`INSPECTION_HOSPITAL_SCOPE_MISSING sourceRecordId=${inspection.airtableRecordId}`);
    } else if (conflictingSources || evidence.size > 1 || conflictsWithExisting) {
      ambiguous += 1;
      stillUnscoped += 1;
      log(
        `INSPECTION_HOSPITAL_SCOPE_AMBIGUOUS sourceRecordId=${inspection.airtableRecordId} ` +
        `directHospitals=${directHospitalIds.size} deviceHospitals=${deviceHospitalIds.size} ` +
        `existingScope=${inspection.sourceHospitalRecordId ? "present" : "missing"}`,
      );
    }
    // Missing or conflicting evidence is never sufficient authority to erase
    // or replace an existing tenant boundary.
    if (!desiredScope || inspection.sourceHospitalRecordId === desiredScope) {
      unchanged += 1;
      continue;
    }
    await prisma.trackedCase.update({
      where: { id: inspection.id },
      data: { sourceHospitalRecordId: desiredScope },
    });
    repaired += 1;
  }
  return {
    scanned: inspections.length,
    repaired,
    unchanged,
    stillUnscoped,
    ambiguous,
  };
}

function metrics(source: AirtableRecordSource) {
  const measured = source as AirtableRecordSource & {
    getRequestMetrics?: () => { requestsMade: number; pagesFetched: number };
  };
  return measured.getRequestMetrics?.() ?? { requestsMade: 0, pagesFetched: 0 };
}
