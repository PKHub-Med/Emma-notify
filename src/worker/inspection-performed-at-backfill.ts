import "dotenv/config";
import { AIRTABLE_TABLE_IDS, INSPECTION_FIELDS } from "../airtable/field-ids.js";
import { AirtableClient } from "../airtable/client.js";
import type { AirtableRecordSource } from "../airtable/types.js";
import { parseAirtableDate } from "../airtable/values.js";
import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import { CaseType } from "../generated/prisma/enums.js";
import { createPrismaClient } from "../db/prisma.js";

export type InspectionPerformedAtBackfillMode = "dry-run" | "apply";

export async function runInspectionPerformedAtBackfill(input: {
  prisma: PrismaClient;
  airtable: AirtableRecordSource;
  mode: InspectionPerformedAtBackfillMode;
  log?: (line: string) => void;
}) {
  const log = input.log ?? console.info;
  const records = await input.airtable.fetchAllRecords(
    AIRTABLE_TABLE_IDS.inspections,
    [INSPECTION_FIELDS.performedAt],
  );
  const sourceValues = new Map(records.map((record) => [
    record.id,
    parseAirtableDate(record.fields[INSPECTION_FIELDS.performedAt]),
  ]));
  const localRows = await input.prisma.trackedCase.findMany({
    where: {
      caseType: CaseType.INSPECTION,
      airtableRecordId: { in: [...sourceValues.keys()] },
    },
    select: { airtableRecordId: true, inspectionPerformedAt: true },
  });
  const changes = localRows.filter((row) =>
    row.inspectionPerformedAt?.getTime() !== sourceValues.get(row.airtableRecordId)?.getTime());
  const report = {
    mode: input.mode,
    airtableInspections: records.length,
    localMatches: localRows.length,
    updates: changes.length,
    setToDate: changes.filter((row) => sourceValues.get(row.airtableRecordId) !== null).length,
    setToNull: changes.filter((row) => sourceValues.get(row.airtableRecordId) === null).length,
  };
  log(JSON.stringify(report, null, 2));
  if (input.mode === "dry-run") return report;

  await input.prisma.$transaction(async (transaction) => {
    for (const row of changes) {
      await transaction.trackedCase.updateMany({
        where: {
          caseType: CaseType.INSPECTION,
          airtableRecordId: row.airtableRecordId,
        },
        data: {
          inspectionPerformedAt: sourceValues.get(row.airtableRecordId) ?? null,
        },
      });
    }
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    maxWait: 10_000,
    timeout: 120_000,
  });
  log(`INSPECTION_PERFORMED_AT_BACKFILL_APPLIED updates=${changes.length}`);
  return report;
}

async function main() {
  const args = process.argv.slice(2);
  const mode: InspectionPerformedAtBackfillMode = args.includes("--apply") ? "apply" : "dry-run";
  if (args.includes("--apply") === args.includes("--dry-run")) {
    throw new Error("Use exactly one of --dry-run or --apply");
  }
  const databaseUrl = process.env.DATABASE_URL?.trim();
  const baseId = process.env.AIRTABLE_BASE_ID?.trim();
  const personalAccessToken = process.env.AIRTABLE_PAT?.trim();
  if (!databaseUrl || !baseId || !personalAccessToken) {
    throw new Error("DATABASE_URL, AIRTABLE_BASE_ID and AIRTABLE_PAT are required");
  }
  const prisma = createPrismaClient(databaseUrl);
  try {
    await runInspectionPerformedAtBackfill({
      prisma,
      airtable: new AirtableClient({ baseId, personalAccessToken }),
      mode,
    });
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/inspection-performed-at-backfill.js")) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
