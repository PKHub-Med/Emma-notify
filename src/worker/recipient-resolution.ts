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

export type RecipientResolutionEvent = {
  id: string;
  sourceEntityType: CommunicationSourceEntityType;
  scenario: CommunicationScenario;
  eventSnapshot: unknown;
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
  findUnresolved(limit: number): Promise<RecipientResolutionEvent[]>;
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
  ): Promise<void>;
}

export class PrismaRecipientResolutionStore implements RecipientResolutionStore {
  constructor(private readonly prisma: PrismaClient) {}

  async findUnresolved(limit: number): Promise<RecipientResolutionEvent[]> {
    return this.prisma.communicationEvent.findMany({
      where: { recipientsResolvedAt: null, processedAt: null },
      orderBy: { detectedAt: "asc" },
      take: limit,
      select: {
        id: true,
        sourceEntityType: true,
        scenario: true,
        eventSnapshot: true,
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
        data: { recipientsResolvedAt: at },
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async markFailed(
    eventId: string,
    recipientType: CommunicationRecipientType,
    sourceContactRecordId: string | null,
    reason: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
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
    });
  }
}

export async function resolvePendingCommunicationRecipients(input: {
  airtable: AirtableIncrementalSource;
  store: RecipientResolutionStore;
  tiemedFallbackEmail: string | null;
  now?: () => Date;
  log?: (message: string) => void;
}): Promise<number> {
  const events = await input.store.findUnresolved(RESOLUTION_LIMIT);
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

  for (const contactRecordId of contactRecordIds) {
    let contactRecord;
    try {
      contactRecord = await input.airtable.fetchRecord(
        AIRTABLE_TABLE_IDS.contacts,
        contactRecordId,
        CONTACT_FIELD_IDS,
      );
    } catch {
      await input.store.markFailed(
        input.event.id,
        CommunicationRecipientType.CLIENT,
        contactRecordId,
        "AIRTABLE_CONTACT_READ_FAILED",
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
      recipient.resolutionStatus === CommunicationRecipientResolutionStatus.READY &&
      recipient.normalizedEmail === resolved.normalizedEmail)) continue;
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
  if (readyCount === 0) {
    if (!input.tiemedFallbackEmail) {
      await input.store.markFailed(
        input.event.id,
        CommunicationRecipientType.TIEMED_FALLBACK,
        null,
        "FALLBACK_MISSING",
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
