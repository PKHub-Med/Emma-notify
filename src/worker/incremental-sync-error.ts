import { AirtableRequestError } from "../airtable/client.js";
import { AIRTABLE_TABLE_IDS } from "../airtable/field-ids.js";

export type IncrementalSyncStage =
  | "TASK"
  | "SERVICE_ORDER"
  | "INSPECTION"
  | "DB"
  | "COMMUNICATION"
  | "UNKNOWN";

export class IncrementalSyncStageError extends Error {
  constructor(readonly stage: IncrementalSyncStage, cause: unknown) {
    super("Incremental synchronization stage failed", { cause });
    this.name = "IncrementalSyncStageError";
  }
}

export async function atIncrementalStage<T>(
  stage: IncrementalSyncStage,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error: unknown) {
    if (error instanceof IncrementalSyncStageError) throw error;
    throw new IncrementalSyncStageError(stage, error);
  }
}

export function formatIncrementalSyncFailure(input: {
  error: unknown;
  fallbackStage?: IncrementalSyncStage;
  durationMs: number;
}): string {
  const stageError = input.error instanceof IncrementalSyncStageError
    ? input.error
    : undefined;
  const error = stageError?.cause ?? input.error;
  const stage = stageError?.stage ?? input.fallbackStage ?? "UNKNOWN";
  const metadata: string[] = [];
  let errorName = error instanceof Error ? error.name : "Error";
  let errorCode = structuralCode(error) ?? "UNKNOWN";
  let message = "Unexpected incremental synchronization error";

  if (error instanceof AirtableRequestError) {
    errorName = error.name;
    errorCode = error.code;
    message = error.message;
    metadata.push(`requestType=${error.requestType}`);
    metadata.push(`requestEntity=${airtableEntity(error.tableId)}`);
    if (error.httpStatus !== undefined) metadata.push(`httpStatus=${error.httpStatus}`);
  } else if (errorCode.startsWith("P")) {
    message = "Prisma database operation failed";
  } else if (error instanceof Error && safeOperationalMessage(error.message)) {
    message = error.message;
  }

  return [
    "INCREMENTAL_SYNC_FAILED",
    `stage=${stage}`,
    `errorName=${safeToken(errorName)}`,
    `errorCode=${safeToken(errorCode)}`,
    `message=${JSON.stringify(cleanMessage(message))}`,
    `durationMs=${Math.max(0, input.durationMs)}`,
    ...metadata,
  ].join(" ");
}

function structuralCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

function safeOperationalMessage(message: string): boolean {
  return /^(Baseline checkpoint missing|Airtable |Database |Communication )/.test(message);
}

function cleanMessage(message: string): string {
  return message.replace(/[\r\n\t]+/g, " ").slice(0, 300);
}

function safeToken(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 100) || "UNKNOWN";
}

function airtableEntity(tableId: string): string {
  if (tableId === AIRTABLE_TABLE_IDS.serviceOrders) return "SERVICE_ORDER";
  if (tableId === AIRTABLE_TABLE_IDS.inspections) return "INSPECTION";
  if (tableId === AIRTABLE_TABLE_IDS.tasks) return "TASK";
  if (tableId === AIRTABLE_TABLE_IDS.contacts) return "CONTACT";
  if (tableId === AIRTABLE_TABLE_IDS.hospitals) return "HOSPITAL";
  return "UNKNOWN";
}
