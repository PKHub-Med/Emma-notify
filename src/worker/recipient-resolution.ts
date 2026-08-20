import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import {
  CommunicationRecipientResolutionStatus,
  CommunicationRecipientType,
  CommunicationSourceEntityType,
  type CommunicationScenario,
} from "../generated/prisma/enums.js";
import {
  AIRTABLE_TABLE_IDS,
  CONTACT_FIELD_IDS,
} from "../airtable/field-ids.js";
import { mapContact, resolveRecipient } from "../airtable/recipient.js";
import type { AirtableIncrementalSource } from "../airtable/types.js";
import { normalizeEmail } from "../shared/normalize-email.js";

const RESOLUTION_LIMIT = 25;
export const MAX_RECIPIENT_RESOLUTION_ATTEMPTS = 4;

export type RecipientResolutionEvent = {
  id: string;
  sourceEntityType: CommunicationSourceEntityType;
  scenario: CommunicationScenario;
  eventSnapshot: unknown;
  recipientResolutionAttemptCount?: number;
};

export type CommunicationEventRecipientInput = {
  recipientType: CommunicationRecipientType;
  sourceContactRecordId: string | null;
  email: string | null;
  normalizedEmail: string | null;
  recipientKey: string;
  resolutionStatus: CommunicationRecipientResolutionStatus;
  resolutionReason: string | null;
};

export interface RecipientResolutionStore {
  findUnresolved(now: Date, limit: number): Promise<RecipientResolutionEvent[]>;
  markResolved(
    eventId: string,
    recipients: readonly CommunicationEventRecipientInput[],
    at: Date,
  ): Promise<void>;
  markFailed(
    eventId: string,
    recipientType: CommunicationRecipientType,
    sourceContactRecordId: string | null,
    reason: string,
    failedAt: Date,
  ): Promise<void>;
  isOptedOut(sourceHospitalRecordId: string, normalizedEmail: string): Promise<boolean>;
}

export class PrismaRecipientResolutionStore implements RecipientResolutionStore {
  constructor(private readonly prisma: PrismaClient) {}

  async findUnresolved(now: Date, limit: number): Promise<RecipientResolutionEvent[]> {
    return this.prisma.communicationEvent.findMany({
      where: {
        recipientsResolvedAt: null,
        processedAt: null,
        OR: [
          { nextRecipientResolutionAt: null },
          { nextRecipientResolutionAt: { lte: now } },
        ],
      },
      orderBy: { detectedAt: "asc" },
      take: limit,
      select: {
        id: true,
        sourceEntityType: true,
        scenario: true,
        eventSnapshot: true,
        recipientResolutionAttemptCount: true,
      },
    });
  }

  async markResolved(
    eventId: string,
    recipients: readonly CommunicationEventRecipientInput[],
    at: Date,
  ): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      const event = await transaction.communicationEvent.findUniqueOrThrow({
        where: { id: eventId },
        select: { recipientsResolvedAt: true },
      });
      if (event.recipientsResolvedAt) return;

      await transaction.communicationEventRecipient.deleteMany({
        where: { communicationEventId: eventId },
      });
      if (recipients.length > 0) {
        await transaction.communicationEventRecipient.createMany({
          data: recipients.map((recipient) => ({
            communicationEventId: eventId,
            ...recipient,
          })),
        });
      }
      await transaction.communicationEvent.update({
        where: { id: eventId },
        data: { recipientsResolvedAt: at, nextRecipientResolutionAt: null },
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async markFailed(
    eventId: string,
    recipientType: CommunicationRecipientType,
    sourceContactRecordId: string | null,
    reason: string,
    failedAt: Date,
  ): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      const event = await transaction.communicationEvent.findUniqueOrThrow({
        where: { id: eventId },
        select: { recipientResolutionAttemptCount: true },
      });
      const attemptCount = event.recipientResolutionAttemptCount + 1;
      const backoffSeconds = recipientResolutionBackoffSeconds(attemptCount);
      await transaction.communicationEventRecipient.deleteMany({
        where: { communicationEventId: eventId },
      });
      await transaction.communicationEventRecipient.create({
        data: {
          communicationEventId: eventId,
          recipientType,
          sourceContactRecordId,
          email: null,
          normalizedEmail: null,
          recipientKey: `FAILED:${reason}:${sourceContactRecordId ?? "EVENT"}`,
          resolutionStatus: CommunicationRecipientResolutionStatus.FAILED,
          resolutionReason: reason,
        },
      });
      await transaction.communicationEvent.update({
        where: { id: eventId },
        data: {
          recipientResolutionAttemptCount: attemptCount,
          nextRecipientResolutionAt: new Date(
            failedAt.getTime() + backoffSeconds * 1_000,
          ),
        },
      });
    });
  }

  async isOptedOut(sourceHospitalRecordId: string, normalizedEmail: string): Promise<boolean> {
    return Boolean(await this.prisma.communicationOptOut.findUnique({
      where: { sourceHospitalRecordId_normalizedEmail: { sourceHospitalRecordId, normalizedEmail } },
      select: { id: true },
    }));
  }
}

export async function resolvePendingCommunicationRecipients(input: {
  airtable: AirtableIncrementalSource;
  store: RecipientResolutionStore;
  tiemedFallbackEmail: string | null;
  now?: () => Date;
  log?: (message: string) => void;
}): Promise<number> {
  const events = await input.store.findUnresolved(
    (input.now ?? (() => new Date()))(),
    RESOLUTION_LIMIT,
  );
  for (const event of events) {
    await resolveCommunicationEventRecipients({ ...input, event });
  }
  return events.length;
}

export async function resolveCommunicationEventRecipients(input: {
  event: RecipientResolutionEvent;
  airtable: AirtableIncrementalSource;
  store: RecipientResolutionStore;
  tiemedFallbackEmail: string | null;
  now?: () => Date;
  log?: (message: string) => void;
}): Promise<void> {
  const contactRecordIds = contactIdsFromSnapshot(input.event);
  const recipients: CommunicationEventRecipientInput[] = [];
  const sourceHospitalRecordId = snapshotString(input.event.eventSnapshot, "sourceHospitalRecordId");
  let validClientEmailCount = 0;

  for (const contactRecordId of contactRecordIds) {
    let contactRecord;
    try {
      contactRecord = await input.airtable.fetchRecord(
        AIRTABLE_TABLE_IDS.contacts,
        contactRecordId,
        CONTACT_FIELD_IDS,
      );
    } catch {
      const failedAt = (input.now ?? (() => new Date()))();
      const failedAttempts = (input.event.recipientResolutionAttemptCount ?? 0) + 1;
      if (failedAttempts >= MAX_RECIPIENT_RESOLUTION_ATTEMPTS && input.tiemedFallbackEmail) {
        const normalizedEmail = normalizeEmail(input.tiemedFallbackEmail);
        await input.store.markResolved(input.event.id, [{
          recipientType: CommunicationRecipientType.TIEMED_FALLBACK,
          sourceContactRecordId: null,
          email: input.tiemedFallbackEmail,
          normalizedEmail,
          recipientKey: normalizedEmail,
          resolutionStatus: CommunicationRecipientResolutionStatus.FALLBACK,
          resolutionReason: `AIRTABLE_CONTACT_READ_FAILED:${failedAttempts}`,
        }], failedAt);
        input.log?.(
          `COMMUNICATION_RECIPIENT_FALLBACK eventId=${input.event.id} ` +
          `reason=AIRTABLE_CONTACT_READ_FAILED failedAttempts=${failedAttempts}`,
        );
        return;
      }
      await input.store.markFailed(
        input.event.id,
        CommunicationRecipientType.CLIENT,
        contactRecordId,
        "AIRTABLE_CONTACT_READ_FAILED",
        failedAt,
      );
      input.log?.(
        `COMMUNICATION_RECIPIENT_RESOLUTION_FAILED eventId=${input.event.id} reason=AIRTABLE_CONTACT_READ_FAILED`,
      );
      return;
    }

    const resolved = resolveRecipient(contactRecordId, mapContact(contactRecord));
    if (!resolved.eligible || !resolved.email || !resolved.normalizedEmail) {
      recipients.push({
        recipientType: CommunicationRecipientType.CLIENT,
        sourceContactRecordId: contactRecordId,
        email: resolved.email,
        normalizedEmail: null,
        recipientKey: `INVALID:${contactRecordId}`,
        resolutionStatus: CommunicationRecipientResolutionStatus.INVALID,
        resolutionReason: resolved.eligibilityReason,
      });
      continue;
    }
    if (recipients.some((recipient) =>
      recipient.normalizedEmail === resolved.normalizedEmail)) continue;
    validClientEmailCount += 1;
    if (sourceHospitalRecordId && await input.store.isOptedOut(sourceHospitalRecordId, resolved.normalizedEmail)) {
      recipients.push({
        recipientType: CommunicationRecipientType.CLIENT,
        sourceContactRecordId: contactRecordId,
        email: resolved.email,
        normalizedEmail: resolved.normalizedEmail,
        recipientKey: `OPTED_OUT:${resolved.normalizedEmail}`,
        resolutionStatus: CommunicationRecipientResolutionStatus.INVALID,
        resolutionReason: "OPTED_OUT",
      });
      continue;
    }
    recipients.push({
      recipientType: CommunicationRecipientType.CLIENT,
      sourceContactRecordId: contactRecordId,
      email: resolved.email,
      normalizedEmail: resolved.normalizedEmail,
      recipientKey: resolved.normalizedEmail,
      resolutionStatus: CommunicationRecipientResolutionStatus.READY,
      resolutionReason: null,
    });
  }

  const readyCount = recipients.filter((recipient) =>
    recipient.resolutionStatus === CommunicationRecipientResolutionStatus.READY).length;
  let fallback = false;
  if (readyCount === 0 && validClientEmailCount === 0) {
    if (!input.tiemedFallbackEmail) {
      await input.store.markFailed(
        input.event.id,
        CommunicationRecipientType.TIEMED_FALLBACK,
        null,
        "FALLBACK_MISSING",
        (input.now ?? (() => new Date()))(),
      );
      input.log?.(
        `COMMUNICATION_RECIPIENT_FALLBACK_MISSING eventId=${input.event.id} scenario=${input.event.scenario}`,
      );
      input.log?.(
        `COMMUNICATION_RECIPIENT_RESOLUTION_FAILED eventId=${input.event.id} reason=FALLBACK_MISSING`,
      );
      return;
    }
    const normalizedEmail = normalizeEmail(input.tiemedFallbackEmail);
    recipients.push({
      recipientType: CommunicationRecipientType.TIEMED_FALLBACK,
      sourceContactRecordId: null,
      email: input.tiemedFallbackEmail,
      normalizedEmail,
      recipientKey: normalizedEmail,
      resolutionStatus: CommunicationRecipientResolutionStatus.FALLBACK,
      resolutionReason: "NO_VALID_CLIENT_EMAIL",
    });
    fallback = true;
    input.log?.(
      `COMMUNICATION_RECIPIENT_FALLBACK eventId=${input.event.id} scenario=${input.event.scenario}`,
    );
  }

  await input.store.markResolved(input.event.id, recipients, (input.now ?? (() => new Date()))());
  input.log?.(
    `COMMUNICATION_RECIPIENTS_RESOLVED eventId=${input.event.id} scenario=${input.event.scenario} recipientCount=${readyCount + (fallback ? 1 : 0)} fallback=${fallback}`,
  );
}

function snapshotString(snapshot: unknown, key: string): string | null {
  if (!isObject(snapshot)) return null;
  const value = snapshot[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function contactIdsFromSnapshot(event: RecipientResolutionEvent): string[] {
  if (!isObject(event.eventSnapshot)) return [];
  const field = event.sourceEntityType === CommunicationSourceEntityType.TASK
    ? "selectedContactRecordIds"
    : "contactRecordIds";
  const value = event.eventSnapshot[field];
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string =>
    typeof item === "string" && item.trim().length > 0))];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function recipientResolutionBackoffSeconds(attemptCount: number): number {
  return Math.min(15 * 2 ** Math.max(0, attemptCount - 1), 15 * 60);
}
