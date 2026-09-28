import { AirtableRequestError } from "../airtable/client.js";
import { AIRTABLE_TABLE_IDS } from "../airtable/field-ids.js";
import { Prisma } from "../generated/prisma/client.js";

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

export type SafePrismaValidationDetails = {
  errorName: "PrismaClientValidationError";
  errorCode: "PRISMA_VALIDATION";
  reason: string;
  model?: string;
  operation?: string;
};

export function unwrapIncrementalSyncError(error: unknown): unknown {
  return error instanceof IncrementalSyncStageError ? error.cause : error;
}

export function safePrismaValidationDetails(
  wrappedError: unknown,
): SafePrismaValidationDetails | null {
  const error = unwrapIncrementalSyncError(wrappedError);
  if (!(error instanceof Error) || !isPrismaValidationError(error)) return null;
  const invocation = error.message.match(
    /prisma\.([A-Za-z][A-Za-z0-9_]*)\.([A-Za-z][A-Za-z0-9_]*)\(\)/,
  );
  return {
    errorName: "PrismaClientValidationError",
    errorCode: "PRISMA_VALIDATION",
    reason: safePrismaValidationReason(error.message),
    ...(invocation?.[1]
      ? { model: invocation[1][0]!.toUpperCase() + invocation[1].slice(1) }
      : {}),
    ...(invocation?.[2] ? { operation: invocation[2] } : {}),
  };
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
  const error = unwrapIncrementalSyncError(input.error);
  const stage = stageError?.stage ?? input.fallbackStage ?? "UNKNOWN";
  const metadata: string[] = [];
  let errorName = error instanceof Error ? error.name : "Error";
  let errorCode = structuralCode(error) ?? "UNKNOWN";
  let message = "Unexpected incremental synchronization error";

  const prismaValidation = safePrismaValidationDetails(error);
  if (prismaValidation) {
    errorName = prismaValidation.errorName;
    errorCode = prismaValidation.errorCode;
    message = "Prisma client validation failed";
    if (prismaValidation.model) metadata.push(`model=${safeToken(prismaValidation.model)}`);
    if (prismaValidation.operation) {
      metadata.push(`operation=${safeToken(prismaValidation.operation)}`);
    }
    metadata.push(`reason=${JSON.stringify(prismaValidation.reason)}`);
  } else if (error instanceof AirtableRequestError) {
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

function isPrismaValidationError(error: Error): boolean {
  return error instanceof Prisma.PrismaClientValidationError ||
    error.name === "PrismaClientValidationError";
}

function safePrismaValidationReason(message: string): string {
  const patterns: Array<{ expression: RegExp; prefix: string }> = [
    { expression: /Unknown argument `([A-Za-z][A-Za-z0-9_]*)`/, prefix: "Unknown argument" },
    { expression: /Argument `([A-Za-z][A-Za-z0-9_]*)` is missing/, prefix: "Missing argument" },
    { expression: /Invalid value for argument `([A-Za-z][A-Za-z0-9_]*)`/, prefix: "Invalid value for argument" },
  ];
  for (const { expression, prefix } of patterns) {
    const field = message.match(expression)?.[1];
    if (field) return `${prefix} ${safeToken(field)}`;
  }
  return "Prisma client validation failed";
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
