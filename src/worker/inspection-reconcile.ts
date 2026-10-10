import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { AIRTABLE_TABLE_IDS, INSPECTION_FIELD_IDS } from "../airtable/field-ids.js";
import { mapInspection, type MappedCase } from "../airtable/mappers.js";
import type { AirtablePaginatedSource } from "../airtable/types.js";
import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import { CaseType, SyncEntityType, SyncStatus } from "../generated/prisma/enums.js";
import { PrismaBaselineStore } from "./baseline-store.js";

const RECONCILE_SOURCE = "AIRTABLE";
const DEFAULT_LEASE_MS = 10 * 60 * 1_000;
const DEFAULT_PAGE_SIZE = 100;

export type InspectionReconcileStats = {
  outcome: "COMPLETED" | "ALREADY_RUNNING" | "APPROVAL_REQUIRED" | "FAILED";
  resumed: boolean;
  recordsRead: number;
  recordsChanged: number;
  recordsUnchanged: number;
  recordsFailed: number;
  pagesProcessed: number;
  durationMs: number;
};

export type InspectionReconcileClaim = Omit<InspectionReconcileStats,
  "outcome" | "durationMs"> & {
    leaseToken: string;
    cursor: string | null;
  };

export interface InspectionReconcileStore {
  isFirstRunApproved(): Promise<boolean>;
  claim(now: Date, leaseToken: string, leaseExpiresAt: Date): Promise<InspectionReconcileClaim | null>;
  commitPage(input: {
    leaseToken: string;
    inspections: readonly MappedCase[];
    nextCursor: string | null;
    seenAt: Date;
    leaseExpiresAt: Date;
  }): Promise<InspectionReconcileClaim>;
  markFailed(leaseToken: string, at: Date, errorCode: string): Promise<InspectionReconcileClaim | null>;
}

export class PrismaInspectionReconcileStore implements InspectionReconcileStore {
  constructor(private readonly prisma: PrismaClient) {}

  async isFirstRunApproved(): Promise<boolean> {
    const state = await this.prisma.syncState.findUnique({
      where: { source_entityType: inspectionReconcileKey() },
      select: { lastSuccessfulSyncAt: true },
    });
    return state?.lastSuccessfulSyncAt !== null && state?.lastSuccessfulSyncAt !== undefined;
  }

  async claim(
    now: Date,
    leaseToken: string,
    leaseExpiresAt: Date,
  ): Promise<InspectionReconcileClaim | null> {
    await this.prisma.syncState.upsert({
      where: { source_entityType: inspectionReconcileKey() },
      create: {
        ...inspectionReconcileKey(),
        status: SyncStatus.IDLE,
      },
      update: {},
    });
    const claimed = await this.prisma.syncState.updateMany({
      where: {
        ...inspectionReconcileKey(),
        OR: [
          { status: { not: SyncStatus.RUNNING } },
          { leaseExpiresAt: null },
          { leaseExpiresAt: { lte: now } },
        ],
      },
      data: {
        status: SyncStatus.RUNNING,
        lastAttemptAt: now,
        lastError: null,
        leaseToken,
        leaseExpiresAt,
      },
    });
    if (claimed.count === 0) return null;

    const state = await this.prisma.syncState.findUniqueOrThrow({
      where: { source_entityType: inspectionReconcileKey() },
    });
    const resumed = state.reconcileCursor !== null;
    if (!resumed) {
      return this.resetCounters(leaseToken);
    }
    return claimFromState(state, true);
  }

  async commitPage(input: {
    leaseToken: string;
    inspections: readonly MappedCase[];
    nextCursor: string | null;
    seenAt: Date;
    leaseExpiresAt: Date;
  }): Promise<InspectionReconcileClaim> {
    return this.prisma.$transaction(async (transaction) => {
      const locked = await transaction.syncState.updateMany({
        where: {
          ...inspectionReconcileKey(),
          status: SyncStatus.RUNNING,
          leaseToken: input.leaseToken,
        },
        data: { leaseExpiresAt: input.leaseExpiresAt },
      });
      if (locked.count !== 1) throw new Error("INSPECTION_RECONCILE_LEASE_LOST");

      const baselineStore = new PrismaBaselineStore(transaction);
      let changed = 0;
      let unchanged = 0;
      for (const inspection of input.inspections) {
        const existing = await transaction.trackedCase.findUnique({
          where: {
            caseType_airtableRecordId: {
              caseType: CaseType.INSPECTION,
              airtableRecordId: inspection.airtableRecordId,
            },
          },
          include: { devices: { select: { deviceAirtableId: true } } },
        });
        if (inspectionChanged(existing, inspection)) changed += 1;
        else unchanged += 1;
        await baselineStore.upsertCase(inspection, input.seenAt);
      }

      const completed = input.nextCursor === null;
      const updated = await transaction.syncState.update({
        where: { source_entityType: inspectionReconcileKey() },
        data: {
          reconcileCursor: input.nextCursor,
          recordsRead: { increment: input.inspections.length },
          recordsChanged: { increment: changed },
          recordsUnchanged: { increment: unchanged },
          pagesProcessed: { increment: 1 },
          ...(completed ? {
            status: SyncStatus.IDLE,
            lastSuccessfulSyncAt: input.seenAt,
            leaseToken: null,
            leaseExpiresAt: null,
          } : {}),
        },
      });
      return claimFromState(updated, true);
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 10_000,
      timeout: 120_000,
    });
  }

  async markFailed(
    leaseToken: string,
    at: Date,
    errorCode: string,
  ): Promise<InspectionReconcileClaim | null> {
    const failed = await this.prisma.syncState.updateMany({
      where: {
        ...inspectionReconcileKey(),
        status: SyncStatus.RUNNING,
        leaseToken,
      },
      data: {
        status: SyncStatus.ERROR,
        lastAttemptAt: at,
        lastError: errorCode,
        recordsFailed: { increment: 1 },
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });
    if (failed.count === 0) return null;
    const state = await this.prisma.syncState.findUniqueOrThrow({
      where: { source_entityType: inspectionReconcileKey() },
    });
    return claimFromState(state, state.reconcileCursor !== null);
  }

  private async resetCounters(leaseToken: string): Promise<InspectionReconcileClaim> {
    const reset = await this.prisma.syncState.updateMany({
      where: {
        ...inspectionReconcileKey(),
        status: SyncStatus.RUNNING,
        leaseToken,
      },
      data: {
        recordsRead: 0,
        recordsChanged: 0,
        recordsUnchanged: 0,
        recordsFailed: 0,
        pagesProcessed: 0,
      },
    });
    if (reset.count !== 1) throw new Error("INSPECTION_RECONCILE_LEASE_LOST");
    const state = await this.prisma.syncState.findUniqueOrThrow({
      where: { source_entityType: inspectionReconcileKey() },
    });
    return claimFromState(state, false);
  }
}

export async function runInspectionReconcile(dependencies: {
  airtable: AirtablePaginatedSource;
  store: InspectionReconcileStore;
  now?: () => Date;
  leaseMs?: number;
  pageSize?: number;
  requirePriorSuccess?: boolean;
  log?: (message: string) => void;
}): Promise<InspectionReconcileStats> {
  const now = dependencies.now ?? (() => new Date());
  const startedAt = now();
  const leaseMs = dependencies.leaseMs ?? DEFAULT_LEASE_MS;
  const pageSize = dependencies.pageSize ?? DEFAULT_PAGE_SIZE;
  if (dependencies.requirePriorSuccess &&
      !await dependencies.store.isFirstRunApproved()) {
    const pendingApproval = emptyStats(
      "APPROVAL_REQUIRED",
      false,
      now().getTime() - startedAt.getTime(),
    );
    dependencies.log?.(formatInspectionReconcileStats(pendingApproval));
    return pendingApproval;
  }
  const leaseToken = randomUUID();
  const claim = await dependencies.store.claim(
    startedAt,
    leaseToken,
    new Date(startedAt.getTime() + leaseMs),
  );
  if (!claim) {
    const skipped = emptyStats("ALREADY_RUNNING", false, now().getTime() - startedAt.getTime());
    dependencies.log?.(formatInspectionReconcileStats(skipped));
    return skipped;
  }

  let state = claim;
  try {
    do {
      const page = await dependencies.airtable.fetchRecordsPage(
        AIRTABLE_TABLE_IDS.inspections,
        INSPECTION_FIELD_IDS,
        {
          pageSize,
          ...(state.cursor ? { offset: state.cursor } : {}),
        },
      );
      const inspections = page.records.map(mapInspection);
      const pageAt = now();
      state = await dependencies.store.commitPage({
        leaseToken,
        inspections,
        nextCursor: page.offset ?? null,
        seenAt: pageAt,
        leaseExpiresAt: new Date(pageAt.getTime() + leaseMs),
      });
      dependencies.log?.(
        `INSPECTION_RECONCILE_PAGE records=${page.records.length} ` +
        `recordsRead=${state.recordsRead} changed=${state.recordsChanged} ` +
        `unchanged=${state.recordsUnchanged} failed=${state.recordsFailed} ` +
        `pages=${state.pagesProcessed} hasMore=${page.offset !== undefined}`,
      );
    } while (state.cursor !== null);

    const completed: InspectionReconcileStats = {
      outcome: "COMPLETED",
      resumed: claim.resumed,
      recordsRead: state.recordsRead,
      recordsChanged: state.recordsChanged,
      recordsUnchanged: state.recordsUnchanged,
      recordsFailed: state.recordsFailed,
      pagesProcessed: state.pagesProcessed,
      durationMs: Math.max(0, now().getTime() - startedAt.getTime()),
    };
    dependencies.log?.(formatInspectionReconcileStats(completed));
    return completed;
  } catch (error: unknown) {
    const errorCode = inspectionReconcileErrorCode(error);
    const failed = await dependencies.store.markFailed(leaseToken, now(), errorCode)
      .catch(() => null);
    const stats: InspectionReconcileStats = {
      outcome: "FAILED",
      resumed: claim.resumed,
      recordsRead: failed?.recordsRead ?? state.recordsRead,
      recordsChanged: failed?.recordsChanged ?? state.recordsChanged,
      recordsUnchanged: failed?.recordsUnchanged ?? state.recordsUnchanged,
      recordsFailed: failed?.recordsFailed ?? state.recordsFailed + 1,
      pagesProcessed: failed?.pagesProcessed ?? state.pagesProcessed,
      durationMs: Math.max(0, now().getTime() - startedAt.getTime()),
    };
    dependencies.log?.(`${formatInspectionReconcileStats(stats)} errorCode=${errorCode}`);
    throw error;
  }
}

export function formatInspectionReconcileStats(stats: InspectionReconcileStats): string {
  return `AIRTABLE_SYNC_STATS entityType=INSPECTION_RECONCILE outcome=${stats.outcome} ` +
    `resumed=${stats.resumed} recordsRead=${stats.recordsRead} ` +
    `changed=${stats.recordsChanged} unchanged=${stats.recordsUnchanged} ` +
    `failed=${stats.recordsFailed} pages=${stats.pagesProcessed} durationMs=${stats.durationMs}`;
}

function inspectionReconcileKey() {
  return {
    source: RECONCILE_SOURCE,
    entityType: SyncEntityType.INSPECTION_RECONCILE,
  } as const;
}

function claimFromState(
  state: {
    reconcileCursor: string | null;
    leaseToken: string | null;
    recordsRead: number;
    recordsChanged: number;
    recordsUnchanged: number;
    recordsFailed: number;
    pagesProcessed: number;
  },
  resumed: boolean,
): InspectionReconcileClaim {
  return {
    leaseToken: state.leaseToken ?? "",
    cursor: state.reconcileCursor,
    resumed,
    recordsRead: state.recordsRead,
    recordsChanged: state.recordsChanged,
    recordsUnchanged: state.recordsUnchanged,
    recordsFailed: state.recordsFailed,
    pagesProcessed: state.pagesProcessed,
  };
}

function inspectionChanged(
  existing: ({ devices: Array<{ deviceAirtableId: string }> } & Record<string, unknown>) | null,
  inspection: MappedCase,
): boolean {
  if (!existing) return true;
  const expected = inspectionComparable(inspection);
  const actual = Object.fromEntries(Object.keys(expected).map((key) => [
    key,
    key === "deviceAirtableIds"
      ? existing.devices.map((item) => item.deviceAirtableId).sort()
      : existing[key],
  ]));
  return !isDeepStrictEqual(normalizeComparable(actual), normalizeComparable(expected));
}

function inspectionComparable(inspection: MappedCase): Record<string, unknown> {
  const {
    contactRecordIds: _contactRecordIds,
    invalidDueDate: _invalidDueDate,
    sourceHospitalRecordId: _sourceHospitalRecordId,
    deviceAirtableIds,
    sourceSnapshot,
    ...caseData
  } = inspection;
  return {
    ...caseData,
    sourceSnapshot,
    deviceAirtableIds: [...deviceAirtableIds].sort(),
    active: true,
  };
}

function normalizeComparable(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeComparable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, normalizeComparable(item)]));
  }
  return value;
}

function inspectionReconcileErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error &&
      typeof error.code === "string" && /^[A-Z0-9_]{1,80}$/.test(error.code)) {
    return error.code;
  }
  if (error instanceof Error && /^[A-Z0-9_]{1,80}$/.test(error.message)) {
    return error.message;
  }
  return "INSPECTION_RECONCILE_FAILED";
}

function emptyStats(
  outcome: InspectionReconcileStats["outcome"],
  resumed: boolean,
  durationMs: number,
): InspectionReconcileStats {
  return {
    outcome,
    resumed,
    recordsRead: 0,
    recordsChanged: 0,
    recordsUnchanged: 0,
    recordsFailed: 0,
    pagesProcessed: 0,
    durationMs: Math.max(0, durationMs),
  };
}
