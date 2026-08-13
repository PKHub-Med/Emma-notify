import type { PrismaClient } from "../generated/prisma/client.js";
import { CaseType, SyncEntityType, SyncStatus } from "../generated/prisma/enums.js";
import { AIRTABLE_TABLE_IDS, SERVICE_ORDER_FIELDS } from "../airtable/field-ids.js";
import type { AirtableRecordSource } from "../airtable/types.js";
import { parseAirtableDate } from "../airtable/values.js";

export async function runReportedAtBackfill(dependencies: {
  prisma: PrismaClient;
  airtable: AirtableRecordSource;
  now?: () => Date;
  log?: (message: string) => void;
}): Promise<number | null> {
  const existing = await dependencies.prisma.syncState.findUnique({
    where: {
      source_entityType: {
        source: "AIRTABLE",
        entityType: SyncEntityType.SERVICE_ORDER_REPORTED_AT,
      },
    },
    select: { baselineCompletedAt: true },
  });
  if (existing?.baselineCompletedAt) return null;
  const now = dependencies.now ?? (() => new Date());
  const startedAt = now();
  const before = requestMetrics(dependencies.airtable);
  await dependencies.prisma.syncState.upsert({
    where: {
      source_entityType: {
        source: "AIRTABLE",
        entityType: SyncEntityType.SERVICE_ORDER_REPORTED_AT,
      },
    },
    create: {
      source: "AIRTABLE",
      entityType: SyncEntityType.SERVICE_ORDER_REPORTED_AT,
      status: SyncStatus.RUNNING,
      lastAttemptAt: startedAt,
    },
    update: { status: SyncStatus.RUNNING, lastAttemptAt: startedAt, lastError: null },
  });
  try {
    const records = await dependencies.airtable.fetchAllRecords(
      AIRTABLE_TABLE_IDS.serviceOrders,
      [SERVICE_ORDER_FIELDS.reportedAt],
    );
    for (const record of records) {
      await dependencies.prisma.trackedCase.updateMany({
        where: { caseType: CaseType.SERVICE_ORDER, airtableRecordId: record.id },
        data: { reportedAt: parseAirtableDate(record.fields[SERVICE_ORDER_FIELDS.reportedAt]) },
      });
    }
    const completedAt = now();
    const after = requestMetrics(dependencies.airtable);
    await dependencies.prisma.syncState.update({
      where: {
        source_entityType: {
          source: "AIRTABLE",
          entityType: SyncEntityType.SERVICE_ORDER_REPORTED_AT,
        },
      },
      data: {
        status: SyncStatus.IDLE,
        lastSuccessfulSyncAt: completedAt,
        baselineCompletedAt: completedAt,
        lastError: null,
      },
    });
    dependencies.log?.(`AIRTABLE_SYNC_STATS entityType=SERVICE_ORDER_REPORTED_AT mode=BASELINE recordsFetched=${records.length} pagesFetched=${after.pagesFetched - before.pagesFetched} requestsMade=${after.requestsMade - before.requestsMade} durationMs=${Math.max(0, completedAt.getTime() - startedAt.getTime())}`);
    return records.length;
  } catch (error: unknown) {
    await dependencies.prisma.syncState.update({
      where: {
        source_entityType: {
          source: "AIRTABLE",
          entityType: SyncEntityType.SERVICE_ORDER_REPORTED_AT,
        },
      },
      data: { status: SyncStatus.ERROR, lastError: "Reported-at backfill failed" },
    });
    throw error;
  }
}

function requestMetrics(source: AirtableRecordSource) {
  const measured = source as AirtableRecordSource & {
    getRequestMetrics?: () => { requestsMade: number; pagesFetched: number };
  };
  return measured.getRequestMetrics?.() ?? { requestsMade: 0, pagesFetched: 0 };
}
