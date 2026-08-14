import type { PrismaClient } from "../generated/prisma/client.js";
import { CaseType, SyncEntityType, SyncStatus } from "../generated/prisma/enums.js";
import {
  AIRTABLE_TABLE_IDS,
  HOSPITAL_FIELDS,
  SERVICE_ORDER_FIELDS,
} from "../airtable/field-ids.js";
import { mapHospital } from "../airtable/hospital.js";
import { toFirstLinkedRecordId } from "../airtable/values.js";
import type { AirtableIncrementalSource } from "../airtable/types.js";
import {
  buildInspectionHospitalScopeIndex,
  synchronizeInspectionHospitalScopes,
  type InspectionHospitalScopeIndex,
} from "./hospital-sync.js";

const CHECKPOINT_SOURCE = "CASE_HOSPITAL_SCOPE_REPAIR_V2";

export type CaseHospitalScopeRepairStats = {
  entityType: "SERVICE_ORDER" | "INSPECTION";
  scanned: number;
  repaired: number;
  unchanged: number;
  stillUnscoped: number;
  ambiguous: number;
  durationMs: number;
};

export interface CaseHospitalScopeRepairStore {
  isCompleted(): Promise<boolean>;
  applyServiceOrderScopes(scopes: ReadonlyMap<string, string | null>): Promise<{
    scanned: number; repaired: number; unchanged: number; stillUnscoped: number;
  }>;
  applyInspectionScopes(
    index: InspectionHospitalScopeIndex,
    log?: (message: string) => void,
  ): Promise<{
    scanned: number; repaired: number; unchanged: number;
    stillUnscoped: number; ambiguous: number;
  }>;
  markCompleted(at: Date): Promise<void>;
}

export class PrismaCaseHospitalScopeRepairStore implements CaseHospitalScopeRepairStore {
  constructor(private readonly prisma: PrismaClient) {}

  async isCompleted(): Promise<boolean> {
    const state = await this.prisma.syncState.upsert({
      where: {
        source_entityType: {
          source: CHECKPOINT_SOURCE,
          entityType: SyncEntityType.SERVICE_ORDER,
        },
      },
      create: {
        source: CHECKPOINT_SOURCE,
        entityType: SyncEntityType.SERVICE_ORDER,
        status: SyncStatus.IDLE,
      },
      update: {},
      select: { baselineCompletedAt: true },
    });
    return state.baselineCompletedAt !== null;
  }

  async applyServiceOrderScopes(scopes: ReadonlyMap<string, string | null>) {
    const rows = await this.prisma.trackedCase.findMany({
      where: { caseType: CaseType.SERVICE_ORDER },
      select: { id: true, airtableRecordId: true, sourceHospitalRecordId: true },
    });
    let repaired = 0;
    let unchanged = 0;
    let stillUnscoped = 0;
    for (const row of rows) {
      const desiredScope = scopes.get(row.airtableRecordId) ?? null;
      if (desiredScope === null) stillUnscoped += 1;
      if (row.sourceHospitalRecordId === desiredScope) {
        unchanged += 1;
        continue;
      }
      await this.prisma.trackedCase.update({
        where: { id: row.id },
        data: { sourceHospitalRecordId: desiredScope },
      });
      repaired += 1;
    }
    return { scanned: rows.length, repaired, unchanged, stillUnscoped };
  }

  async applyInspectionScopes(
    index: InspectionHospitalScopeIndex,
    log: (message: string) => void = console.warn,
  ) {
    return synchronizeInspectionHospitalScopes(this.prisma, index, log);
  }

  async markCompleted(at: Date): Promise<void> {
    await this.prisma.syncState.update({
      where: {
        source_entityType: {
          source: CHECKPOINT_SOURCE,
          entityType: SyncEntityType.SERVICE_ORDER,
        },
      },
      data: {
        status: SyncStatus.IDLE,
        baselineCompletedAt: at,
        lastSuccessfulSyncAt: at,
        lastError: null,
      },
    });
  }
}

export async function runCaseHospitalScopeRepair(input: {
  store: CaseHospitalScopeRepairStore;
  airtable: AirtableIncrementalSource;
  now?: () => Date;
  log?: (message: string) => void;
}): Promise<{ skipped: boolean; stats: CaseHospitalScopeRepairStats[] }> {
  const now = input.now ?? (() => new Date());
  const log = input.log ?? console.info;
  if (await input.store.isCompleted()) {
    log("CASE_HOSPITAL_SCOPE_REPAIR version=V2 skipped reason=already_completed");
    return { skipped: true, stats: [] };
  }

  const stats: CaseHospitalScopeRepairStats[] = [];
  const serviceStartedAt = now();
  // The legacy local snapshot did not persist the linked Hospital Record ID.
  // A one-time, one-field scan is therefore required to restore the canonical
  // source and to clear any scope that was incorrectly derived from a Device.
  const records = await input.airtable.fetchAllRecords(
    AIRTABLE_TABLE_IDS.serviceOrders,
    [SERVICE_ORDER_FIELDS.sourceHospitalLink],
  );
  const scopes = new Map<string, string | null>();
  for (const record of records) {
    scopes.set(
      record.id,
      toFirstLinkedRecordId(record.fields[SERVICE_ORDER_FIELDS.sourceHospitalLink]),
    );
  }
  const serviceResult = await input.store.applyServiceOrderScopes(scopes);
  const serviceStats: CaseHospitalScopeRepairStats = {
    entityType: "SERVICE_ORDER",
    ...serviceResult,
    ambiguous: 0,
    durationMs: Math.max(0, now().getTime() - serviceStartedAt.getTime()),
  };
  stats.push(serviceStats);
  log(formatStats(serviceStats));

  const inspectionStartedAt = now();
  const hospitalRecords = await input.airtable.fetchAllRecords(
    AIRTABLE_TABLE_IDS.hospitals,
    [HOSPITAL_FIELDS.inspectionLinks],
  );
  const inspectionResult = await input.store.applyInspectionScopes(
    buildInspectionHospitalScopeIndex(hospitalRecords.map(mapHospital)),
    log,
  );
  const inspectionStats: CaseHospitalScopeRepairStats = {
    entityType: "INSPECTION",
    ...inspectionResult,
    durationMs: Math.max(0, now().getTime() - inspectionStartedAt.getTime()),
  };
  stats.push(inspectionStats);
  log(formatStats(inspectionStats));
  await input.store.markCompleted(now());
  return { skipped: false, stats };
}

function formatStats(stats: CaseHospitalScopeRepairStats): string {
  return `CASE_HOSPITAL_SCOPE_REPAIR version=V2 entityType=${stats.entityType} ` +
    `scanned=${stats.scanned} repaired=${stats.repaired} unchanged=${stats.unchanged} ` +
    `stillUnscoped=${stats.stillUnscoped} ambiguous=${stats.ambiguous} ` +
    `durationMs=${stats.durationMs}`;
}
