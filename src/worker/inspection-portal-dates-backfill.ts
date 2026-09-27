import "dotenv/config";
import { AirtableClient } from "../airtable/client.js";
import { AIRTABLE_TABLE_IDS, INSPECTION_FIELDS } from "../airtable/field-ids.js";
import { mapInspection } from "../airtable/mappers.js";
import type { AirtableRecordSource } from "../airtable/types.js";
import { createPrismaClient } from "../db/prisma.js";
import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import { CaseType } from "../generated/prisma/enums.js";

export type InspectionPortalDatesBackfillMode = "dry-run" | "apply";

export type InspectionPortalDatesBackfillTarget =
  | { businessNumber: string }
  | { sourceRecordId: string };

type StoredInspection = {
  id: string;
  airtableRecordId: string;
  businessNumber: string | null;
  inspectionScheduledDate: Date | null;
  inspectionValidUntil: Date | null;
};

type DateChange = {
  id: string;
  businessNumber: string | null;
  sourceRecordId: string;
  inspectionScheduledDate: { old: Date | null; new: Date | null };
  inspectionValidUntil: { old: Date | null; new: Date | null };
};

type BackfillSkip = {
  businessNumber: string | null;
  sourceRecordId: string;
  reason: "SKIPPED_AIRTABLE_RECORD_MISSING" | "SKIPPED_INVALID_VALID_UNTIL";
  rawValue?: string;
};

type BackfillFailure = {
  businessNumber: string | null;
  sourceRecordId: string;
  reason: "INVALID_SCHEDULED_DATE" | "APPLY_BATCH_FAILED";
  rawValue?: string;
  errorMessage?: string;
};

type ApplySummary = {
  planned: number;
  committed: number;
  failed: number;
  notAttempted: number;
  completedBatches: number;
  totalBatches: number;
  failedBatch: number | null;
  durationMs: number;
};

type AppliedVerification = {
  businessNumber: string | null;
  sourceRecordId: string;
  inspectionScheduledDate: Date | null;
  inspectionValidUntil: Date | null;
};

const APPLY_BATCH_SIZE = 250;

const SOURCE_FIELD_IDS = [
  INSPECTION_FIELDS.businessNumber,
  INSPECTION_FIELDS.scheduledDate,
  INSPECTION_FIELDS.emmaValidUntil,
] as const;

export async function runInspectionPortalDatesBackfill(input: {
  prisma: PrismaClient;
  airtable: AirtableRecordSource;
  mode: InspectionPortalDatesBackfillMode;
  log?: (line: string) => void;
  batchSize?: number;
  target?: InspectionPortalDatesBackfillTarget;
}) {
  const log = input.log ?? console.info;
  const batchSize = input.batchSize ?? APPLY_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) {
    throw new Error("batchSize must be an integer between 1 and 500");
  }
  const records = await input.airtable.fetchAllRecords(
    AIRTABLE_TABLE_IDS.inspections,
    SOURCE_FIELD_IDS,
  );
  const sourceById = new Map(records.map((record) => [record.id, record]));
  const targetWhere = input.target
    ? "businessNumber" in input.target
      ? { businessNumber: input.target.businessNumber }
      : { airtableRecordId: input.target.sourceRecordId }
    : {};
  const stored = await input.prisma.trackedCase.findMany({
    where: { caseType: CaseType.INSPECTION, active: true, ...targetWhere },
    orderBy: [{ businessNumber: "asc" }, { airtableRecordId: "asc" }],
    select: {
      id: true,
      airtableRecordId: true,
      businessNumber: true,
      inspectionScheduledDate: true,
      inspectionValidUntil: true,
    },
  });
  if (input.target && stored.length !== 1) {
    throw new Error(
      `INSPECTION_PORTAL_DATES_BACKFILL_TARGET_MATCH_COUNT expected=1 actual=${stored.length}`,
    );
  }

  const changes: DateChange[] = [];
  const skipped: BackfillSkip[] = [];
  const failed: BackfillFailure[] = [];
  let unchanged = 0;

  for (const row of stored) {
    const record = sourceById.get(row.airtableRecordId);
    if (!record) {
      skipped.push(skip(row, "SKIPPED_AIRTABLE_RECORD_MISSING"));
      continue;
    }
    const mapped = mapInspection(record);
    const scheduledRaw = rawText(record.fields[INSPECTION_FIELDS.scheduledDate]);
    const validUntilRaw = rawText(record.fields[INSPECTION_FIELDS.emmaValidUntil]);
    if (validUntilRaw && validUntilRaw !== "—" && !mapped.inspectionValidUntil) {
      skipped.push(skip(row, "SKIPPED_INVALID_VALID_UNTIL", validUntilRaw));
      continue;
    }
    if (scheduledRaw && !mapped.inspectionScheduledDate) {
      failed.push(failure(row, "INVALID_SCHEDULED_DATE", scheduledRaw));
      continue;
    }

    const scheduledChanged = !sameDate(
      row.inspectionScheduledDate,
      mapped.inspectionScheduledDate,
    );
    const validUntilChanged = !sameDate(
      row.inspectionValidUntil,
      mapped.inspectionValidUntil,
    );
    if (!scheduledChanged && !validUntilChanged) {
      unchanged += 1;
      continue;
    }
    changes.push({
      id: row.id,
      businessNumber: mapped.businessNumber ?? row.businessNumber,
      sourceRecordId: row.airtableRecordId,
      inspectionScheduledDate: {
        old: row.inspectionScheduledDate,
        new: mapped.inspectionScheduledDate,
      },
      inspectionValidUntil: {
        old: row.inspectionValidUntil,
        new: mapped.inspectionValidUntil,
      },
    });
  }

  const report = {
    mode: input.mode,
    target: input.target ?? null,
    changes: changes.map(({ id: _id, ...change }) => change),
    skipped,
    failed,
    summary: {
      checked: stored.length,
      UPDATED: changes.length,
      SKIPPED_INVALID_VALID_UNTIL: skipped.filter((entry) =>
        entry.reason === "SKIPPED_INVALID_VALID_UNTIL").length,
      SKIPPED_AIRTABLE_RECORD_MISSING: skipped.filter((entry) =>
        entry.reason === "SKIPPED_AIRTABLE_RECORD_MISSING").length,
      UNCHANGED: unchanged,
      FAILED: failed.length,
      scheduledDateChanges: changes.filter((change) =>
        !sameDate(change.inspectionScheduledDate.old, change.inspectionScheduledDate.new)).length,
      validUntilChanges: changes.filter((change) =>
        !sameDate(change.inspectionValidUntil.old, change.inspectionValidUntil.new)).length,
    },
  };
  log(JSON.stringify(report, null, 2));
  if (input.mode === "dry-run") return report;
  if (failed.length > 0) {
    throw new Error(`INSPECTION_PORTAL_DATES_BACKFILL_HAS_FAILURES count=${failed.length}`);
  }

  const applyStartedAt = Date.now();
  const batches = chunk(changes, batchSize);
  let committed = 0;
  for (const [batchIndex, batch] of batches.entries()) {
    const batchNumber = batchIndex + 1;
    log(`APPLY batch ${batchNumber}/${batches.length}`);
    try {
      await input.prisma.$transaction(async (transaction) => {
        for (const change of batch) {
          const result = await transaction.trackedCase.updateMany({
            where: {
              id: change.id,
              caseType: CaseType.INSPECTION,
              active: true,
              inspectionScheduledDate: change.inspectionScheduledDate.old,
              inspectionValidUntil: change.inspectionValidUntil.old,
            },
            data: {
              inspectionScheduledDate: change.inspectionScheduledDate.new,
              inspectionValidUntil: change.inspectionValidUntil.new,
            },
          });
          if (result.count !== 1) {
            throw new Error(
              `INSPECTION_PORTAL_DATES_BACKFILL_CONCURRENT_CHANGE sourceRecordId=${change.sourceRecordId}`,
            );
          }
        }
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 30_000,
      });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const batchFailures: BackfillFailure[] = batch.map((change) => ({
        businessNumber: change.businessNumber,
        sourceRecordId: change.sourceRecordId,
        reason: "APPLY_BATCH_FAILED",
        errorMessage,
      }));
      const applySummary: ApplySummary = {
        planned: changes.length,
        committed,
        failed: batch.length,
        notAttempted: changes.length - committed - batch.length,
        completedBatches: batchIndex,
        totalBatches: batches.length,
        failedBatch: batchNumber,
        durationMs: Date.now() - applyStartedAt,
      };
      const failedReport = appliedReport(report, committed, batchFailures, applySummary);
      log(`APPLY batch ${batchNumber}/${batches.length} FAILED: ${errorMessage}`);
      log(
        `INSPECTION_PORTAL_DATES_BACKFILL_APPLY_SUMMARY ${JSON.stringify({
          ...failedReport.summary,
          apply: applySummary,
        })}`,
      );
      throw new InspectionPortalDatesBackfillApplyError(failedReport, errorMessage);
    }
    committed += batch.length;
    log(`APPLY batch ${batchNumber}/${batches.length} committed=${batch.length}`);
  }

  const verification = input.target
    ? await readAppliedTarget(input.prisma, stored[0]!.id)
    : null;
  const applySummary: ApplySummary = {
    planned: changes.length,
    committed,
    failed: 0,
    notAttempted: 0,
    completedBatches: batches.length,
    totalBatches: batches.length,
    failedBatch: null,
    durationMs: Date.now() - applyStartedAt,
  };
  const applied = appliedReport(report, committed, [], applySummary, verification);
  if (verification) {
    log(
      `INSPECTION_PORTAL_DATES_BACKFILL_VERIFICATION ${JSON.stringify(verification)}`,
    );
  }
  log(
    `INSPECTION_PORTAL_DATES_BACKFILL_APPLY_SUMMARY ${JSON.stringify({
      ...applied.summary,
      apply: applySummary,
    })}`,
  );
  return applied;
}

export class InspectionPortalDatesBackfillApplyError extends Error {
  constructor(
    readonly report: ReturnType<typeof appliedReport>,
    causeMessage: string,
  ) {
    super(
      `INSPECTION_PORTAL_DATES_BACKFILL_APPLY_FAILED committed=${report.apply.committed} `
      + `failed=${report.apply.failed} notAttempted=${report.apply.notAttempted}: ${causeMessage}`,
    );
    this.name = "InspectionPortalDatesBackfillApplyError";
  }
}

function appliedReport<TReport extends {
  failed: BackfillFailure[];
  summary: { UPDATED: number; FAILED: number };
}>(
  report: TReport,
  committed: number,
  applyFailures: BackfillFailure[],
  apply: ApplySummary,
  verification: AppliedVerification | null = null,
) {
  return {
    ...report,
    failed: [...report.failed, ...applyFailures],
    summary: {
      ...report.summary,
      UPDATED: committed,
      FAILED: report.failed.length + applyFailures.length,
    },
    apply,
    verification,
  };
}

async function readAppliedTarget(
  prisma: PrismaClient,
  id: string,
): Promise<AppliedVerification> {
  const row = await prisma.trackedCase.findUnique({
    where: { id },
    select: {
      businessNumber: true,
      airtableRecordId: true,
      inspectionScheduledDate: true,
      inspectionValidUntil: true,
    },
  });
  if (!row) {
    throw new Error(`INSPECTION_PORTAL_DATES_BACKFILL_POST_APPLY_RECORD_MISSING id=${id}`);
  }
  return {
    businessNumber: row.businessNumber,
    sourceRecordId: row.airtableRecordId,
    inspectionScheduledDate: row.inspectionScheduledDate,
    inspectionValidUntil: row.inspectionValidUntil,
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

function skip(
  row: StoredInspection,
  reason: BackfillSkip["reason"],
  rawValue?: string,
): BackfillSkip {
  return reportEntry(row, reason, rawValue);
}

function failure(
  row: StoredInspection,
  reason: BackfillFailure["reason"],
  rawValue?: string,
): BackfillFailure {
  return reportEntry(row, reason, rawValue);
}

function reportEntry<TReason extends string>(
  row: StoredInspection,
  reason: TReason,
  rawValue?: string,
) {
  return {
    businessNumber: row.businessNumber,
    sourceRecordId: row.airtableRecordId,
    reason,
    ...(rawValue === undefined ? {} : { rawValue }),
  };
}

function rawText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sameDate(left: Date | null, right: Date | null): boolean {
  return left?.getTime() === right?.getTime();
}

async function main() {
  const apply = process.argv.includes("--apply");
  const dryRun = process.argv.includes("--dry-run");
  if (apply === dryRun) throw new Error("Use exactly one of --dry-run or --apply");
  const businessNumber = cliOption("business-number");
  const sourceRecordId = cliOption("source-record-id");
  if (businessNumber && sourceRecordId) {
    throw new Error("Use at most one of --business-number or --source-record-id");
  }
  const target: InspectionPortalDatesBackfillTarget | undefined = businessNumber
    ? { businessNumber }
    : sourceRecordId
      ? { sourceRecordId }
      : undefined;
  const databaseUrl = process.env.DATABASE_URL?.trim();
  const baseId = process.env.AIRTABLE_BASE_ID?.trim();
  const personalAccessToken = process.env.AIRTABLE_PAT?.trim();
  if (!databaseUrl || !baseId || !personalAccessToken) {
    throw new Error("DATABASE_URL, AIRTABLE_BASE_ID and AIRTABLE_PAT are required");
  }
  const prisma = createPrismaClient(databaseUrl);
  try {
    await runInspectionPortalDatesBackfill({
      prisma,
      airtable: new AirtableClient({ baseId, personalAccessToken }),
      mode: apply ? "apply" : "dry-run",
      ...(target ? { target } : {}),
    });
  } finally {
    await prisma.$disconnect();
  }
}

function cliOption(name: string): string | undefined {
  const prefix = `--${name}=`;
  const matches = process.argv.filter((argument) => argument.startsWith(prefix));
  if (matches.length > 1) throw new Error(`Use --${name} at most once`);
  if (matches.length === 0) return undefined;
  const value = matches[0]!.slice(prefix.length).trim();
  if (!value) throw new Error(`--${name} requires a non-empty value`);
  return value;
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/inspection-portal-dates-backfill.js")) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
