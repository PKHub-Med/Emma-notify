import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import { SyncEntityType, SyncStatus } from "../generated/prisma/enums.js";
import {
  AIRTABLE_TABLE_IDS,
  HOSPITAL_FIELD_IDS,
} from "../airtable/field-ids.js";
import { mapHospital, type MappedHospital } from "../airtable/hospital.js";
import type { AirtableRecordSource } from "../airtable/types.js";

export interface HospitalSyncStore {
  upsert(hospital: MappedHospital, seenAt: Date): Promise<void>;
  markRunning(at: Date): Promise<void>;
  markSuccessful(at: Date): Promise<void>;
  markFailed(at: Date): Promise<void>;
}

export class PrismaHospitalSyncStore implements HospitalSyncStore {
  constructor(private readonly prisma: PrismaClient) {}

  async upsert(hospital: MappedHospital, seenAt: Date): Promise<void> {
    const snapshot = {
      shortName: hospital.shortName,
      name: hospital.name,
      address: hospital.address,
    } as Prisma.InputJsonObject;
    await this.prisma.trackedHospital.upsert({
      where: { airtableRecordId: hospital.airtableRecordId },
      create: { ...hospital, sourceSnapshot: snapshot, lastSeenAt: seenAt },
      update: { ...hospital, sourceSnapshot: snapshot, lastSeenAt: seenAt },
    });
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
    for (const record of records) {
      await dependencies.store.upsert(mapHospital(record), startedAt);
    }
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

function metrics(source: AirtableRecordSource) {
  const measured = source as AirtableRecordSource & {
    getRequestMetrics?: () => { requestsMade: number; pagesFetched: number };
  };
  return measured.getRequestMetrics?.() ?? { requestsMade: 0, pagesFetched: 0 };
}
