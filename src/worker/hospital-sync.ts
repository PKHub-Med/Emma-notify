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
  ): Promise<InspectionHospitalScopeStats>;
  markRunning(at: Date): Promise<void>;
  markSuccessful(at: Date): Promise<void>;
  markFailed(at: Date): Promise<void>;
}

export class PrismaHospitalSyncStore implements HospitalSyncStore {
  constructor(private readonly prisma: PrismaClient) {}

  async upsert(hospital: MappedHospital, seenAt: Date): Promise<void> {
    const { linkedInspectionRecordIds: _linkedInspectionRecordIds, ...hospitalData } = hospital;
    const snapshot = {
      shortName: hospital.shortName,
      name: hospital.name,
      address: hospital.address,
    } as Prisma.InputJsonObject;
    await this.prisma.trackedHospital.upsert({
      where: { airtableRecordId: hospital.airtableRecordId },
      create: { ...hospitalData, sourceSnapshot: snapshot, lastSeenAt: seenAt },
      update: { ...hospitalData, sourceSnapshot: snapshot, lastSeenAt: seenAt },
    });
  }

  async synchronizeInspectionScopes(
    index: InspectionHospitalScopeIndex,
    log: (message: string) => void = console.warn,
  ): Promise<InspectionHospitalScopeStats> {
    return synchronizeInspectionHospitalScopes(this.prisma, index, log);
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
  prisma: PrismaClient,
  index: InspectionHospitalScopeIndex,
  log: (message: string) => void = console.warn,
): Promise<InspectionHospitalScopeStats> {
  const inspections = await prisma.trackedCase.findMany({
    where: { caseType: CaseType.INSPECTION },
    select: { id: true, airtableRecordId: true, sourceHospitalRecordId: true },
  });
  let repaired = 0;
  let unchanged = 0;
  let stillUnscoped = 0;
  let ambiguous = 0;

  for (const inspection of inspections) {
    const hospitalIds = index.get(inspection.airtableRecordId) ?? new Set<string>();
    const desiredScope = hospitalIds.size === 1
      ? hospitalIds.values().next().value ?? null
      : null;
    if (hospitalIds.size === 0) {
      stillUnscoped += 1;
      log(`INSPECTION_HOSPITAL_SCOPE_MISSING sourceRecordId=${inspection.airtableRecordId}`);
    } else if (hospitalIds.size > 1) {
      ambiguous += 1;
      stillUnscoped += 1;
      log(
        `INSPECTION_HOSPITAL_SCOPE_AMBIGUOUS sourceRecordId=${inspection.airtableRecordId} ` +
        `uniqueHospitals=${hospitalIds.size}`,
      );
    }
    if (inspection.sourceHospitalRecordId === desiredScope) {
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
