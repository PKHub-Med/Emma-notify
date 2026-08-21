import "dotenv/config";
import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import { CaseType } from "../generated/prisma/enums.js";
import { AirtableClient } from "../airtable/client.js";
import { AIRTABLE_TABLE_IDS, INSPECTION_FIELDS } from "../airtable/field-ids.js";
import { toEstimatedDurationSeconds } from "../airtable/mappers.js";
import type { AirtableRecordSource } from "../airtable/types.js";
import { createPrismaClient } from "../db/prisma.js";

export type InspectionDurationBackfillMode = "dry-run" | "apply";

type StoredInspectionDuration = {
  id: string;
  airtableRecordId: string;
  sourceSnapshot: unknown;
};

type DurationChange = {
  id: string;
  estimatedDurationSeconds: number | null;
};

export interface InspectionDurationBackfillStore {
  findInspections(): Promise<StoredInspectionDuration[]>;
  applyChanges(changes: readonly DurationChange[]): Promise<{ updated: number; failed: number }>;
}

export class PrismaInspectionDurationBackfillStore implements InspectionDurationBackfillStore {
  constructor(private readonly prisma: PrismaClient) {}

  findInspections(): Promise<StoredInspectionDuration[]> {
    return this.prisma.trackedCase.findMany({
      where: { caseType: CaseType.INSPECTION },
      select: { id: true, airtableRecordId: true, sourceSnapshot: true },
    });
  }

  async applyChanges(changes: readonly DurationChange[]): Promise<{ updated: number; failed: number }> {
    let updated = 0;
    let failed = 0;
    for (let index = 0; index < changes.length; index += 250) {
      const batch = changes.slice(index, index + 250);
      try {
        const counts = await this.prisma.$transaction(batch.map((change) => this.prisma.$executeRaw(Prisma.sql`
          UPDATE "TrackedCase"
          SET "sourceSnapshot" = jsonb_set(
            COALESCE("sourceSnapshot", '{}'::jsonb),
            '{estimatedDurationSeconds}',
            CAST(${JSON.stringify(change.estimatedDurationSeconds)} AS jsonb),
            true
          )
          WHERE id = ${change.id} AND "caseType" = 'INSPECTION'
        `)));
        const batchUpdated = counts.reduce((sum, count) => sum + count, 0);
        updated += batchUpdated;
        failed += Math.max(0, batch.length - batchUpdated);
      } catch {
        failed += batch.length;
      }
    }
    return { updated, failed };
  }
}

export async function runInspectionDurationBackfill(input: {
  airtable: AirtableRecordSource;
  store: InspectionDurationBackfillStore;
  mode: InspectionDurationBackfillMode;
  log?: (line: string) => void;
}) {
  const records = await input.airtable.fetchAllRecords(
    AIRTABLE_TABLE_IDS.inspections,
    [INSPECTION_FIELDS.estimatedDuration],
  );
  const stored = await input.store.findInspections();
  const byAirtableId = new Map(stored.map((row) => [row.airtableRecordId, row]));
  const changes: DurationChange[] = [];
  let withSourceValue = 0;
  let missing = 0;
  let unchanged = 0;
  let failed = 0;

  for (const record of records) {
    const raw = record.fields[INSPECTION_FIELDS.estimatedDuration];
    const sourceValue = toEstimatedDurationSeconds(raw);
    const sourceIsMissing = raw === undefined || raw === null ||
      typeof raw === "string" && !raw.trim();
    if (sourceValue === null && !sourceIsMissing) {
      failed += 1;
      continue;
    }
    if (sourceValue === null) missing += 1;
    else withSourceValue += 1;

    const row = byAirtableId.get(record.id);
    if (!row) {
      failed += 1;
      continue;
    }
    const snapshot = object(row.sourceSnapshot);
    const storedValue = toEstimatedDurationSeconds(snapshot.estimatedDurationSeconds);
    if (storedValue === sourceValue) {
      unchanged += 1;
      continue;
    }
    changes.push({ id: row.id, estimatedDurationSeconds: sourceValue });
  }

  let changed = changes.length;
  if (input.mode === "apply" && changes.length > 0) {
    const applied = await input.store.applyChanges(changes);
    changed = applied.updated;
    failed += applied.failed;
  }
  const report = {
    mode: input.mode,
    scanned: records.length,
    withSourceValue,
    missing,
    changed,
    unchanged,
    failed,
  };
  (input.log ?? console.info)(JSON.stringify(report, null, 2));
  return report;
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

async function main() {
  const apply = process.argv.includes("--apply");
  const dryRun = process.argv.includes("--dry-run");
  if (apply === dryRun) throw new Error("Use exactly one of --dry-run or --apply");
  const databaseUrl = process.env.DATABASE_URL?.trim();
  const baseId = process.env.AIRTABLE_BASE_ID?.trim();
  const personalAccessToken = process.env.AIRTABLE_PAT?.trim();
  if (!databaseUrl || !baseId || !personalAccessToken) {
    throw new Error("DATABASE_URL, AIRTABLE_BASE_ID and AIRTABLE_PAT are required");
  }
  const prisma = createPrismaClient(databaseUrl);
  try {
    await runInspectionDurationBackfill({
      airtable: new AirtableClient({ baseId, personalAccessToken }),
      store: new PrismaInspectionDurationBackfillStore(prisma),
      mode: apply ? "apply" : "dry-run",
    });
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/inspection-duration-backfill.js")) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
