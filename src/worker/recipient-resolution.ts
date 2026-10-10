import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import {
  CommunicationRecipientResolutionStatus,
  CommunicationRecipientType,
  CommunicationSourceEntityType,
  type CommunicationScenario,
} from "../generated/prisma/enums.js";
import {
  AIRTABLE_TABLE_IDS,
  CONTACT_FIELDS,
  CONTACT_FIELD_IDS,
  HOSPITAL_FIELDS,
  SERVICE_ORDER_FIELDS,
  TASK_FIELDS,
} from "../airtable/field-ids.js";
import {
  AmbiguousRepairRecipientEmailError,
  parseRepairRecipientEmail,
} from "../airtable/mappers.js";
import {
  mapContact,
  resolveRecipient,
  resolveRepairEmailRecipient,
} from "../airtable/recipient.js";
import { resolveCommunicationScenario } from "../airtable/template-scenario.js";
import type { AirtableIncrementalSource } from "../airtable/types.js";
import { toLinkedRecordIds, toOptionalString } from "../airtable/values.js";
import { normalizeEmail } from "../shared/normalize-email.js";
import type {
  RecipientDebugContact,
  RecipientDebugField,
  RecipientResolutionDebugTrace,
} from "./communication-email-debug.js";

const RESOLUTION_LIMIT = 25;
export const MAX_RECIPIENT_RESOLUTION_ATTEMPTS = 4;
const REPAIR_RECIPIENT_REFRESH_FIELDS = [
  SERVICE_ORDER_FIELDS.repairRecipientEmail,
  SERVICE_ORDER_FIELDS.emmaCustomerStatus,
  SERVICE_ORDER_FIELDS.emmaMailTemplate,
  SERVICE_ORDER_FIELDS.sourceHospitalLink,
] as const;

export type RecipientResolutionEvent = {
  id: string;
  sourceRecordId: string;
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
    debugTrace?: RecipientResolutionDebugTrace,
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
        sourceRecordId: true,
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
    debugTrace?: RecipientResolutionDebugTrace,
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
        data: {
          recipientsResolvedAt: at,
          nextRecipientResolutionAt: null,
          ...(debugTrace
            ? { recipientResolutionDebug: debugTrace as unknown as Prisma.InputJsonObject }
            : {}),
        },
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
  debugEnabled?: boolean;
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
  debugEnabled?: boolean;
  now?: () => Date;
  log?: (message: string) => void;
}): Promise<void> {
  const recipients: CommunicationEventRecipientInput[] = [];
  const sourceHospitalRecordId = snapshotString(input.event.eventSnapshot, "sourceHospitalRecordId");
  const debugTrace = input.debugEnabled ? createDebugTrace(input.event) : undefined;

  if (input.event.sourceEntityType === CommunicationSourceEntityType.SERVICE_ORDER) {
    await resolveRepairRecipient(input, sourceHospitalRecordId, recipients, debugTrace);
    return;
  }

  const primaryContactRecordIds = primaryContactIdsFromSnapshot(input.event);
  let validClientEmailCount = 0;

  const resolveContactGroup = async (
    contactRecordIds: readonly string[],
    source: RecipientDebugContact["source"],
  ): Promise<boolean> => {
    for (const contactRecordId of contactRecordIds) {
      let contactRecord;
      try {
        contactRecord = await input.airtable.fetchRecord(
          AIRTABLE_TABLE_IDS.contacts,
          contactRecordId,
          CONTACT_FIELD_IDS,
        );
      } catch {
        await handleAirtableReadFailure(input, contactRecordId, debugTrace);
        return false;
      }

      const resolved = resolveRecipient(contactRecordId, mapContact(contactRecord));
      if (!resolved.eligible || !resolved.email || !resolved.normalizedEmail) {
        addContactDebug(debugTrace, contactRecord, source, resolved.normalizedEmail,
          "REJECTED", resolved.eligibilityReason);
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
        recipient.normalizedEmail === resolved.normalizedEmail)) {
        addContactDebug(debugTrace, contactRecord, source, resolved.normalizedEmail,
          "SKIPPED", "DUPLICATE_NORMALIZED_EMAIL");
        continue;
      }
      validClientEmailCount += 1;
      if (sourceHospitalRecordId && await input.store.isOptedOut(sourceHospitalRecordId, resolved.normalizedEmail)) {
        addContactDebug(debugTrace, contactRecord, source, resolved.normalizedEmail,
          "REJECTED", "OPTED_OUT");
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
      addContactDebug(debugTrace, contactRecord, source, resolved.normalizedEmail,
        "ACCEPTED", "ELIGIBLE");
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
    return true;
  };

  if (!await resolveContactGroup(primaryContactRecordIds, "PRIMARY_CONTACT_LINK")) return;

  let readyCount = countReadyRecipients(recipients);
  if (input.event.sourceEntityType === CommunicationSourceEntityType.TASK && readyCount === 0) {
    const fallbackContactRecordIds = fallbackContactIdsFromSnapshot(input.event);
    if (fallbackContactRecordIds.length > 0 && sourceHospitalRecordId) {
      let hospitalRecord;
      try {
        hospitalRecord = await input.airtable.fetchRecord(
          AIRTABLE_TABLE_IDS.hospitals,
          sourceHospitalRecordId,
          [HOSPITAL_FIELDS.contactLinks],
        );
      } catch {
        await handleAirtableReadFailure(input, null, debugTrace);
        return;
      }

      if (hospitalRecord) {
        debugTrace?.sourceFields.push(debugField(
          "HOSPITAL_FIELDS.contactLinks",
          HOSPITAL_FIELDS.contactLinks,
          null,
          hospitalRecord.fields[HOSPITAL_FIELDS.contactLinks],
        ));
        const hospitalContactIds = new Set(linkedRecordIds(
          hospitalRecord.fields[HOSPITAL_FIELDS.contactLinks],
        ));
        const primaryIds = new Set(primaryContactRecordIds);
        const scopedFallbackIds: string[] = [];
        for (const contactRecordId of fallbackContactRecordIds) {
          if (primaryIds.has(contactRecordId)) continue;
          if (hospitalContactIds.has(contactRecordId)) {
            scopedFallbackIds.push(contactRecordId);
          } else {
            addUnscopedContactDebug(debugTrace, contactRecordId);
            recipients.push({
              recipientType: CommunicationRecipientType.CLIENT,
              sourceContactRecordId: contactRecordId,
              email: null,
              normalizedEmail: null,
              recipientKey: `INVALID_SCOPE:${contactRecordId}`,
              resolutionStatus: CommunicationRecipientResolutionStatus.INVALID,
              resolutionReason: "HOSPITAL_SCOPE_MISMATCH",
            });
          }
        }
        if (!await resolveContactGroup(
          scopedFallbackIds,
          "HOSPITAL_FALLBACK_CONTACT_LINK",
        )) return;
      }
    }
  }

  readyCount = countReadyRecipients(recipients);
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
    debugTrace?.consideredAddresses.push({
      address: input.tiemedFallbackEmail,
      normalizedAddress: normalizedEmail,
      source: "TIEMED_FALLBACK_EMAIL",
      decision: "ACCEPTED",
      reason: "NO_VALID_CLIENT_EMAIL",
    });
    fallback = true;
    input.log?.(
      `COMMUNICATION_RECIPIENT_FALLBACK eventId=${input.event.id} scenario=${input.event.scenario}`,
    );
  }

  if (debugTrace) {
    debugTrace.finalRecipients = recipients
      .filter((recipient) => recipient.resolutionStatus ===
        CommunicationRecipientResolutionStatus.READY ||
        recipient.resolutionStatus === CommunicationRecipientResolutionStatus.FALLBACK)
      .flatMap((recipient) => recipient.normalizedEmail ? [{
        address: recipient.normalizedEmail,
        source: recipient.sourceContactRecordId
          ? `CONTACT:${recipient.sourceContactRecordId}`
          : "TIEMED_FALLBACK_EMAIL",
        status: recipient.resolutionStatus,
        reason: recipient.resolutionReason,
      }] : []);
  }
  await input.store.markResolved(
    input.event.id,
    recipients,
    (input.now ?? (() => new Date()))(),
    debugTrace,
  );
  input.log?.(
    `COMMUNICATION_RECIPIENTS_RESOLVED eventId=${input.event.id} scenario=${input.event.scenario} recipientCount=${readyCount + (fallback ? 1 : 0)} fallback=${fallback}`,
  );
}

function createDebugTrace(event: RecipientResolutionEvent): RecipientResolutionDebugTrace {
  const snapshot = isObject(event.eventSnapshot) ? event.eventSnapshot : {};
  const task = event.sourceEntityType === CommunicationSourceEntityType.TASK;
  const sourceFields: RecipientDebugField[] = task
    ? [
        debugField("TASK_FIELDS.selectedContactLinks", TASK_FIELDS.selectedContactLinks,
          "Imie i nazwisko", snapshot.selectedContactRecordIds),
        debugField("TASK_FIELDS.contactLinks", TASK_FIELDS.contactLinks,
          "Osoba kontaktowa (from SZPITAL)", snapshot.fallbackContactRecordIds),
        debugField("TASK_FIELDS.sourceHospitalLink", TASK_FIELDS.sourceHospitalLink,
          null, snapshot.sourceHospitalRecordId),
      ]
    : [
        debugField("SERVICE_ORDER_FIELDS.repairRecipientEmail",
          SERVICE_ORDER_FIELDS.repairRecipientEmail, "EMMA: mail DT",
          snapshot.repairRecipientEmail),
        debugField("SERVICE_ORDER_FIELDS.sourceHospitalLink",
          SERVICE_ORDER_FIELDS.sourceHospitalLink, null, snapshot.sourceHospitalRecordId),
        debugField("SERVICE_ORDER_FIELDS.hospitalName", SERVICE_ORDER_FIELDS.hospitalName,
          null, snapshot.hospitalName),
      ];
  return {
    version: 1,
    sourceEntityType: event.sourceEntityType,
    sourceRecordId: event.sourceRecordId,
    hospitalRecordId: snapshotString(snapshot, "sourceHospitalRecordId"),
    hospitalName: snapshotString(snapshot, "hospitalName"),
    sourceFields,
    ...(task ? {} : {
      repairRecipientResolution: {
        source: "EVENT_SNAPSHOT" as const,
        airtableRefetched: false,
        refetchedAt: null,
      },
    }),
    contacts: [],
    consideredAddresses: [],
    finalRecipients: [],
  };
}

async function resolveRepairRecipient(
  input: {
    event: RecipientResolutionEvent;
    airtable: AirtableIncrementalSource;
    store: RecipientResolutionStore;
    now?: () => Date;
    log?: (message: string) => void;
  },
  sourceHospitalRecordId: string | null,
  recipients: CommunicationEventRecipientInput[],
  debugTrace?: RecipientResolutionDebugTrace,
): Promise<void> {
  const resolvedAt = (input.now ?? (() => new Date()))();
  const rawValue = isObject(input.event.eventSnapshot)
    ? input.event.eventSnapshot.repairRecipientEmail
    : null;
  let resolved = resolveRepairEmailRecipient(
    typeof rawValue === "string" ? rawValue : null,
  );
  let recipientSource = "SERVICE_ORDER_FIELDS.repairRecipientEmail";

  if (resolved.eligibilityReason !== "ELIGIBLE") {
    let currentRecord;
    try {
      currentRecord = await input.airtable.fetchRecord(
        AIRTABLE_TABLE_IDS.serviceOrders,
        input.event.sourceRecordId,
        REPAIR_RECIPIENT_REFRESH_FIELDS,
      );
    } catch {
      await retryOrInvalidateRepairRecipient(
        input, recipients, debugTrace, "REPAIR_RECIPIENT_AIRTABLE_READ_FAILED",
        null, "AIRTABLE_REFETCH", resolvedAt,
      );
      return;
    }

    const refetchedAt = resolvedAt.toISOString();
    if (debugTrace) {
      debugTrace.repairRecipientResolution = {
        source: "AIRTABLE_REFETCH",
        airtableRefetched: true,
        refetchedAt,
      };
      debugTrace.sourceFields.push(
        debugField(
          "AIRTABLE_REFETCH.SERVICE_ORDER_FIELDS.repairRecipientEmail",
          SERVICE_ORDER_FIELDS.repairRecipientEmail,
          "EMMA: mail DT",
          currentRecord.fields[SERVICE_ORDER_FIELDS.repairRecipientEmail],
        ),
        debugField(
          "AIRTABLE_REFETCH.SERVICE_ORDER_FIELDS.emmaCustomerStatus",
          SERVICE_ORDER_FIELDS.emmaCustomerStatus,
          null,
          currentRecord.fields[SERVICE_ORDER_FIELDS.emmaCustomerStatus],
        ),
        debugField(
          "AIRTABLE_REFETCH.SERVICE_ORDER_FIELDS.emmaMailTemplate",
          SERVICE_ORDER_FIELDS.emmaMailTemplate,
          null,
          currentRecord.fields[SERVICE_ORDER_FIELDS.emmaMailTemplate],
        ),
        debugField(
          "AIRTABLE_REFETCH.SERVICE_ORDER_FIELDS.sourceHospitalLink",
          SERVICE_ORDER_FIELDS.sourceHospitalLink,
          null,
          currentRecord.fields[SERVICE_ORDER_FIELDS.sourceHospitalLink],
        ),
      );
    }

    const currentScenario = resolveCommunicationScenario({
      sourceEntityType: "SERVICE_ORDER",
      emmaCustomerStatus: toOptionalString(
        currentRecord.fields[SERVICE_ORDER_FIELDS.emmaCustomerStatus],
      ),
      emmaMailTemplate: toOptionalString(
        currentRecord.fields[SERVICE_ORDER_FIELDS.emmaMailTemplate],
      ),
    });
    if (currentScenario !== input.event.scenario) {
      await invalidateRepairRecipient(
        input, recipients, debugTrace, "REPAIR_RECIPIENT_SCENARIO_CHANGED",
        null, "AIRTABLE_REFETCH", resolvedAt,
      );
      return;
    }

    const currentHospitalRecordIds = toLinkedRecordIds(
      currentRecord.fields[SERVICE_ORDER_FIELDS.sourceHospitalLink],
    );
    if (currentHospitalRecordIds.length > 1 ||
        (currentHospitalRecordIds[0] ?? null) !== sourceHospitalRecordId) {
      await invalidateRepairRecipient(
        input, recipients, debugTrace, "REPAIR_RECIPIENT_HOSPITAL_CHANGED",
        null, "AIRTABLE_REFETCH", resolvedAt,
      );
      return;
    }

    let currentEmail: string | null;
    try {
      currentEmail = parseRepairRecipientEmail(
        currentRecord.fields[SERVICE_ORDER_FIELDS.repairRecipientEmail],
      );
    } catch (error) {
      const reason = error instanceof AmbiguousRepairRecipientEmailError
        ? "REPAIR_RECIPIENT_EMAIL_AMBIGUOUS"
        : "REPAIR_RECIPIENT_EMAIL_INVALID";
      await retryOrInvalidateRepairRecipient(
        input, recipients, debugTrace, reason, null, "AIRTABLE_REFETCH", resolvedAt,
      );
      return;
    }
    resolved = resolveRepairEmailRecipient(currentEmail);
    recipientSource = "AIRTABLE_REFETCH.SERVICE_ORDER_FIELDS.repairRecipientEmail";
    if (resolved.eligibilityReason !== "ELIGIBLE") {
      const reason = resolved.eligibilityReason === "MISSING_EMAIL"
        ? "REPAIR_RECIPIENT_EMAIL_MISSING"
        : "REPAIR_RECIPIENT_EMAIL_INVALID";
      await retryOrInvalidateRepairRecipient(
        input, recipients, debugTrace, reason, resolved.email,
        recipientSource, resolvedAt,
      );
      return;
    }
  }

  const trimmedEmail = resolved.email ?? "";
  const normalizedEmail = resolved.normalizedEmail;

  if (sourceHospitalRecordId && normalizedEmail &&
      await input.store.isOptedOut(sourceHospitalRecordId, normalizedEmail)) {
    recipients.push({
      recipientType: CommunicationRecipientType.CLIENT,
      sourceContactRecordId: null,
      email: trimmedEmail,
      normalizedEmail,
      recipientKey: `OPTED_OUT:${normalizedEmail}`,
      resolutionStatus: CommunicationRecipientResolutionStatus.INVALID,
      resolutionReason: "OPTED_OUT",
    });
    debugTrace?.consideredAddresses.push({
      address: trimmedEmail,
      normalizedAddress: normalizedEmail,
      source: recipientSource,
      decision: "REJECTED",
      reason: "OPTED_OUT",
    });
    await input.store.markResolved(input.event.id, recipients, resolvedAt, debugTrace);
    input.log?.(
      `COMMUNICATION_REPAIR_RECIPIENT_REJECTED eventId=${input.event.id} ` +
      `scenario=${input.event.scenario} reason=OPTED_OUT`,
    );
    return;
  }

  recipients.push({
    recipientType: CommunicationRecipientType.CLIENT,
    sourceContactRecordId: null,
    email: trimmedEmail,
    normalizedEmail,
    recipientKey: normalizedEmail!,
    resolutionStatus: CommunicationRecipientResolutionStatus.READY,
    resolutionReason: null,
  });
  if (debugTrace) {
    debugTrace.consideredAddresses.push({
      address: trimmedEmail,
      normalizedAddress: normalizedEmail,
      source: recipientSource,
      decision: "ACCEPTED",
      reason: "ELIGIBLE",
    });
    debugTrace.finalRecipients = [{
      address: normalizedEmail!,
      source: recipientSource,
      status: CommunicationRecipientResolutionStatus.READY,
      reason: null,
    }];
  }
  await input.store.markResolved(input.event.id, recipients, resolvedAt, debugTrace);
  input.log?.(
    `COMMUNICATION_RECIPIENTS_RESOLVED eventId=${input.event.id} ` +
    `scenario=${input.event.scenario} recipientCount=1 fallback=false`,
  );
}

async function retryOrInvalidateRepairRecipient(
  input: {
    event: RecipientResolutionEvent;
    store: RecipientResolutionStore;
    now?: () => Date;
    log?: (message: string) => void;
  },
  recipients: CommunicationEventRecipientInput[],
  debugTrace: RecipientResolutionDebugTrace | undefined,
  reason: string,
  email: string | null,
  source: string,
  failedAt: Date,
): Promise<void> {
  const failedAttempts = (input.event.recipientResolutionAttemptCount ?? 0) + 1;
  if (failedAttempts < MAX_RECIPIENT_RESOLUTION_ATTEMPTS) {
    await input.store.markFailed(
      input.event.id,
      CommunicationRecipientType.CLIENT,
      null,
      reason,
      failedAt,
    );
    input.log?.(
      `COMMUNICATION_RECIPIENT_RESOLUTION_FAILED eventId=${input.event.id} ` +
      `reason=${reason} failedAttempts=${failedAttempts}`,
    );
    return;
  }
  await invalidateRepairRecipient(
    input, recipients, debugTrace, reason, email, source, failedAt,
  );
}

async function invalidateRepairRecipient(
  input: {
    event: RecipientResolutionEvent;
    store: RecipientResolutionStore;
    log?: (message: string) => void;
  },
  recipients: CommunicationEventRecipientInput[],
  debugTrace: RecipientResolutionDebugTrace | undefined,
  reason: string,
  email: string | null,
  source: string,
  resolvedAt: Date,
): Promise<void> {
  recipients.push({
    recipientType: CommunicationRecipientType.CLIENT,
    sourceContactRecordId: null,
    email,
    normalizedEmail: null,
    recipientKey: `INVALID:${reason}`,
    resolutionStatus: CommunicationRecipientResolutionStatus.INVALID,
    resolutionReason: reason,
  });
  debugTrace?.consideredAddresses.push({
    address: email,
    normalizedAddress: null,
    source,
    decision: "REJECTED",
    reason,
  });
  await input.store.markResolved(input.event.id, recipients, resolvedAt, debugTrace);
  input.log?.(
    `COMMUNICATION_REPAIR_RECIPIENT_REJECTED eventId=${input.event.id} ` +
    `scenario=${input.event.scenario} reason=${reason}`,
  );
}

function addContactDebug(
  trace: RecipientResolutionDebugTrace | undefined,
  record: { id: string; fields: Record<string, unknown> },
  source: RecipientDebugContact["source"],
  normalizedEmail: string | null,
  decision: RecipientDebugContact["decision"],
  reason: string,
): void {
  if (!trace) return;
  const rawEmail = optionalDebugString(record.fields[CONTACT_FIELDS.email]);
  const fields = [
    debugField("CONTACT_FIELDS.name", CONTACT_FIELDS.name, null,
      record.fields[CONTACT_FIELDS.name]),
    debugField("CONTACT_FIELDS.contactable", CONTACT_FIELDS.contactable, null,
      record.fields[CONTACT_FIELDS.contactable]),
    debugField("CONTACT_FIELDS.email", CONTACT_FIELDS.email, null,
      record.fields[CONTACT_FIELDS.email]),
  ];
  trace.contacts.push({
    recordId: record.id,
    source,
    fields,
    rawEmail,
    normalizedEmail,
    decision,
    reason,
  });
  trace.consideredAddresses.push({
    address: rawEmail,
    normalizedAddress: normalizedEmail,
    source: `${source}:${record.id}:CONTACT_FIELDS.email`,
    decision,
    reason,
  });
}

function addUnscopedContactDebug(
  trace: RecipientResolutionDebugTrace | undefined,
  contactRecordId: string,
): void {
  if (!trace) return;
  trace.contacts.push({
    recordId: contactRecordId,
    source: "HOSPITAL_FALLBACK_CONTACT_LINK",
    fields: [],
    rawEmail: null,
    normalizedEmail: null,
    decision: "SKIPPED",
    reason: "HOSPITAL_SCOPE_MISMATCH",
  });
  trace.consideredAddresses.push({
    address: null,
    normalizedAddress: null,
    source: `HOSPITAL_FALLBACK_CONTACT_LINK:${contactRecordId}`,
    decision: "SKIPPED",
    reason: "HOSPITAL_SCOPE_MISMATCH; contact record was not read",
  });
}

function debugField(
  codeName: string,
  airtableFieldId: string,
  airtableDisplayName: string | null,
  value: unknown,
): RecipientDebugField {
  return {
    codeName,
    airtableFieldId,
    airtableDisplayName,
    value: value === undefined ? null : value,
  };
}

function optionalDebugString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function snapshotString(snapshot: unknown, key: string): string | null {
  if (!isObject(snapshot)) return null;
  const value = snapshot[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function primaryContactIdsFromSnapshot(event: RecipientResolutionEvent): string[] {
  if (!isObject(event.eventSnapshot)) return [];
  const field = event.sourceEntityType === CommunicationSourceEntityType.TASK
    ? "selectedContactRecordIds"
    : "contactRecordIds";
  const value = event.eventSnapshot[field];
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string =>
    typeof item === "string" && item.trim().length > 0))];
}

function fallbackContactIdsFromSnapshot(event: RecipientResolutionEvent): string[] {
  if (!isObject(event.eventSnapshot)) return [];
  return linkedRecordIds(event.eventSnapshot.fallbackContactRecordIds);
}

function linkedRecordIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string =>
    typeof item === "string" && item.trim().length > 0))];
}

function countReadyRecipients(recipients: readonly CommunicationEventRecipientInput[]): number {
  return recipients.filter((recipient) =>
    recipient.resolutionStatus === CommunicationRecipientResolutionStatus.READY).length;
}

async function handleAirtableReadFailure(
  input: {
    event: RecipientResolutionEvent;
    store: RecipientResolutionStore;
    tiemedFallbackEmail: string | null;
    now?: () => Date;
    log?: (message: string) => void;
  },
  sourceContactRecordId: string | null,
  debugTrace?: RecipientResolutionDebugTrace,
): Promise<void> {
  const failedAt = (input.now ?? (() => new Date()))();
  const failedAttempts = (input.event.recipientResolutionAttemptCount ?? 0) + 1;
  if (failedAttempts >= MAX_RECIPIENT_RESOLUTION_ATTEMPTS && input.tiemedFallbackEmail) {
    const normalizedEmail = normalizeEmail(input.tiemedFallbackEmail);
    if (debugTrace) {
      debugTrace.consideredAddresses.push({
        address: null,
        normalizedAddress: null,
        source: sourceContactRecordId
          ? `CONTACT:${sourceContactRecordId}`
          : "HOSPITAL_SCOPE_READ",
        decision: "REJECTED",
        reason: `AIRTABLE_CONTACT_READ_FAILED:${failedAttempts}`,
      }, {
        address: input.tiemedFallbackEmail,
        normalizedAddress: normalizedEmail,
        source: "TIEMED_FALLBACK_EMAIL",
        decision: "ACCEPTED",
        reason: `AIRTABLE_CONTACT_READ_FAILED:${failedAttempts}`,
      });
      debugTrace.finalRecipients = [{
        address: normalizedEmail,
        source: "TIEMED_FALLBACK_EMAIL",
        status: CommunicationRecipientResolutionStatus.FALLBACK,
        reason: `AIRTABLE_CONTACT_READ_FAILED:${failedAttempts}`,
      }];
    }
    await input.store.markResolved(input.event.id, [{
      recipientType: CommunicationRecipientType.TIEMED_FALLBACK,
      sourceContactRecordId: null,
      email: input.tiemedFallbackEmail,
      normalizedEmail,
      recipientKey: normalizedEmail,
      resolutionStatus: CommunicationRecipientResolutionStatus.FALLBACK,
      resolutionReason: `AIRTABLE_CONTACT_READ_FAILED:${failedAttempts}`,
    }], failedAt, debugTrace);
    input.log?.(
      `COMMUNICATION_RECIPIENT_FALLBACK eventId=${input.event.id} ` +
      `reason=AIRTABLE_CONTACT_READ_FAILED failedAttempts=${failedAttempts}`,
    );
    return;
  }
  await input.store.markFailed(
    input.event.id,
    CommunicationRecipientType.CLIENT,
    sourceContactRecordId,
    "AIRTABLE_CONTACT_READ_FAILED",
    failedAt,
  );
  input.log?.(
    `COMMUNICATION_RECIPIENT_RESOLUTION_FAILED eventId=${input.event.id} reason=AIRTABLE_CONTACT_READ_FAILED`,
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function recipientResolutionBackoffSeconds(attemptCount: number): number {
  return Math.min(15 * 2 ** Math.max(0, attemptCount - 1), 15 * 60);
}
