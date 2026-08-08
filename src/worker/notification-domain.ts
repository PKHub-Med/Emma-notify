import { createHash } from "node:crypto";
import type { CaseType, EventType } from "../generated/prisma/enums.js";

export function normalizeStatus(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed ? trimmed : null;
}

export function createEventFingerprint(input: {
  caseType: CaseType;
  airtableRecordId: string;
  fieldName: string;
  oldValue: string | null;
  newValue: string | null;
  sourceModifiedAt: Date | null;
  eventType: EventType;
}): string {
  const payload = JSON.stringify([
    input.caseType,
    input.airtableRecordId,
    input.eventType,
    input.fieldName,
    normalizeStatus(input.oldValue),
    normalizeStatus(input.newValue),
    input.sourceModifiedAt?.toISOString() ?? null,
  ]);
  return createHash("sha256").update(payload).digest("hex");
}

export function calculateSendAfter(now: Date, quietMinutes: number): Date {
  return new Date(now.getTime() + quietMinutes * 60_000);
}

export function shouldMarkBufferReady(
  status: "OPEN" | "READY" | "CLOSED" | "CANCELLED",
  sendAfter: Date,
  now: Date,
): boolean {
  return status === "OPEN" && sendAfter.getTime() <= now.getTime();
}
