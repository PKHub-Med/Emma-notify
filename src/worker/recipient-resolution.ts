import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import {
  CommunicationDiagnosticOrigin,
  CommunicationDiagnosticStatus,
  CommunicationRecipientResolutionStatus,
  CommunicationRecipientType,
  CommunicationSourceEntityType,
  type CommunicationScenario,
} from "../generated/prisma/enums.js";
import {
  AIRTABLE_TABLE_IDS,
  SERVICE_ORDER_FIELDS,
  TASK_FIELDS,
} from "../airtable/field-ids.js";
import {
  AmbiguousRepairRecipientEmailError,
  parseRepairRecipientEmail,
} from "../airtable/mappers.js";
import { resolveRepairEmailRecipient } from "../airtable/recipient.js";
import { resolveCommunicationScenario } from "../airtable/template-scenario.js";
import type { AirtableIncrementalSource } from "../airtable/types.js";
import { toLinkedRecordIds, toOptionalString } from "../airtable/values.js";
import { normalizeEmail } from "../shared/normalize-email.js";
import type { CommunicationDiagnosticRegistry } from "./communication-diagnostics.js";
import type {
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
const TASK_RECIPIENT_SOURCE = "TASK.EMMA_MAIL_DT";
const FALLBACK_RECIPIENT_SOURCE = "TIEMED_FALLBACK_EMAIL";

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
  diagnostics?: CommunicationDiagnosticRegistry;
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
  diagnostics?: CommunicationDiagnosticRegistry;
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
  await resolveTaskRecipient(input, recipients, debugTrace);
}

async function resolveTaskRecipient(
  input: Parameters<typeof resolveCommunicationEventRecipients>[0],
  recipients: CommunicationEventRecipientInput[],
  debugTrace?: RecipientResolutionDebugTrace,
): Promise<void> {
  const resolvedAt = (input.now ?? (() => new Date()))();
  const snapshot = isObject(input.event.eventSnapshot) ? input.event.eventSnapshot : {};
  const snapshotContainsField = Object.prototype.hasOwnProperty.call(
    snapshot,
    "emmaRecipientEmail",
  );
  let rawValue = snapshotContainsField ? snapshot.emmaRecipientEmail : null;

  if (!snapshotContainsField) {
    let currentRecord;
    try {
      currentRecord = await input.airtable.fetchRecord(
        AIRTABLE_TABLE_IDS.tasks,
        input.event.sourceRecordId,
        [TASK_FIELDS.emmaRecipientEmail],
      );
    } catch {
      const failedAttempts = (input.event.recipientResolutionAttemptCount ?? 0) + 1;
      if (failedAttempts < MAX_RECIPIENT_RESOLUTION_ATTEMPTS) {
        await input.store.markFailed(
          input.event.id,
          CommunicationRecipientType.CLIENT,
          null,
          "TASK_RECIPIENT_AIRTABLE_READ_FAILED",
          resolvedAt,
        );
      } else {
        await invalidateTaskRecipient(
          input,
          recipients,
          debugTrace,
          "TASK_RECIPIENT_AIRTABLE_READ_FAILED",
          null,
          resolvedAt,
        );
      }
      input.log?.(
        `COMMUNICATION_RECIPIENT_RESOLUTION_FAILED eventId=${input.event.id} ` +
        `reason=TASK_RECIPIENT_AIRTABLE_READ_FAILED failedAttempts=${failedAttempts}`,
      );
      await recordRecipientDiagnostic(
        input,
        CommunicationDiagnosticStatus.BLOCKED,
        "TASK_RECIPIENT_AIRTABLE_READ_FAILED",
      );
      return;
    }
    rawValue = currentRecord.fields[TASK_FIELDS.emmaRecipientEmail] ?? null;
    if (debugTrace) {
      debugTrace.taskRecipientResolution = {
        source: "AIRTABLE_REFETCH",
        airtableRefetched: true,
        refetchedAt: resolvedAt.toISOString(),
      };
      debugTrace.sourceFields.push(debugField(
        "AIRTABLE_REFETCH.TASK_FIELDS.emmaRecipientEmail",
        TASK_FIELDS.emmaRecipientEmail,
        "EMMA: mail DT",
        rawValue,
      ));
    }
  }

  let parsedEmail: string | null;
  try {
    parsedEmail = parseRepairRecipientEmail(rawValue);
  } catch (error) {
    const reason = error instanceof AmbiguousRepairRecipientEmailError
      ? "TASK_RECIPIENT_EMAIL_AMBIGUOUS"
      : "TASK_RECIPIENT_EMAIL_INVALID";
    await invalidateTaskRecipient(
      input,
      recipients,
      debugTrace,
      reason,
      typeof rawValue === "string" ? rawValue.trim() || null : null,
      resolvedAt,
    );
    await recordRecipientDiagnostic(input, CommunicationDiagnosticStatus.BLOCKED, reason);
    return;
  }

  const resolved = resolveRepairEmailRecipient(parsedEmail);
  if (resolved.eligibilityReason === "INVALID_EMAIL") {
    await invalidateTaskRecipient(
      input,
      recipients,
      debugTrace,
      "TASK_RECIPIENT_EMAIL_INVALID",
      resolved.email,
      resolvedAt,
    );
    await recordRecipientDiagnostic(
      input,
      CommunicationDiagnosticStatus.BLOCKED,
      "TASK_RECIPIENT_EMAIL_INVALID",
    );
    return;
  }

  if (resolved.eligibilityReason === "MISSING_EMAIL") {
    if (!input.tiemedFallbackEmail) {
      await invalidateTaskRecipient(
        input,
        recipients,
        debugTrace,
        "TASK_RECIPIENT_FALLBACK_MISSING",
        null,
        resolvedAt,
        FALLBACK_RECIPIENT_SOURCE,
      );
      input.log?.(
        `COMMUNICATION_RECIPIENT_FALLBACK_MISSING eventId=${input.event.id} ` +
        `scenario=${input.event.scenario} source=${FALLBACK_RECIPIENT_SOURCE}`,
      );
      await recordRecipientDiagnostic(
        input,
        CommunicationDiagnosticStatus.BLOCKED,
        "TASK_RECIPIENT_FALLBACK_MISSING",
        FALLBACK_RECIPIENT_SOURCE,
      );
      return;
    }
    const normalizedFallback = normalizeEmail(input.tiemedFallbackEmail);
    recipients.push({
      recipientType: CommunicationRecipientType.TIEMED_FALLBACK,
      sourceContactRecordId: null,
      email: input.tiemedFallbackEmail,
      normalizedEmail: normalizedFallback,
      recipientKey: normalizedFallback,
      resolutionStatus: CommunicationRecipientResolutionStatus.FALLBACK,
      resolutionReason: "TASK_EMMA_MAIL_DT_EMPTY",
    });
    debugTrace?.consideredAddresses.push({
      address: input.tiemedFallbackEmail,
      normalizedAddress: normalizedFallback,
      source: FALLBACK_RECIPIENT_SOURCE,
      decision: "ACCEPTED",
      reason: "TASK_EMMA_MAIL_DT_EMPTY",
    });
    if (debugTrace) {
      debugTrace.finalRecipients = [{
        address: normalizedFallback,
        source: FALLBACK_RECIPIENT_SOURCE,
        status: CommunicationRecipientResolutionStatus.FALLBACK,
        reason: "TASK_EMMA_MAIL_DT_EMPTY",
      }];
    }
    await input.store.markResolved(input.event.id, recipients, resolvedAt, debugTrace);
    input.log?.(
      `COMMUNICATION_RECIPIENT_FALLBACK eventId=${input.event.id} ` +
      `scenario=${input.event.scenario} source=${FALLBACK_RECIPIENT_SOURCE}`,
    );
    await recordRecipientDiagnostic(
      input,
      CommunicationDiagnosticStatus.READY,
      "TASK_RECIPIENT_FALLBACK_USED",
      FALLBACK_RECIPIENT_SOURCE,
    );
    return;
  }

  recipients.push({
    recipientType: CommunicationRecipientType.CLIENT,
    sourceContactRecordId: null,
    email: resolved.email,
    normalizedEmail: resolved.normalizedEmail,
    recipientKey: resolved.normalizedEmail!,
    resolutionStatus: CommunicationRecipientResolutionStatus.READY,
    resolutionReason: null,
  });
  debugTrace?.consideredAddresses.push({
    address: resolved.email,
    normalizedAddress: resolved.normalizedEmail,
    source: TASK_RECIPIENT_SOURCE,
    decision: "ACCEPTED",
    reason: "ELIGIBLE",
  });
  if (debugTrace) {
    debugTrace.finalRecipients = [{
      address: resolved.normalizedEmail!,
      source: TASK_RECIPIENT_SOURCE,
      status: CommunicationRecipientResolutionStatus.READY,
      reason: null,
    }];
  }
  await input.store.markResolved(input.event.id, recipients, resolvedAt, debugTrace);
  input.log?.(
    `COMMUNICATION_RECIPIENTS_RESOLVED eventId=${input.event.id} ` +
    `scenario=${input.event.scenario} recipientCount=1 fallback=false ` +
    `source=${TASK_RECIPIENT_SOURCE}`,
  );
  await recordRecipientDiagnostic(
    input,
    CommunicationDiagnosticStatus.READY,
    "TASK_RECIPIENT_RESOLVED",
  );
}

async function invalidateTaskRecipient(
  input: Parameters<typeof resolveCommunicationEventRecipients>[0],
  recipients: CommunicationEventRecipientInput[],
  debugTrace: RecipientResolutionDebugTrace | undefined,
  reason: string,
  email: string | null,
  resolvedAt: Date,
  source = TASK_RECIPIENT_SOURCE,
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
    `COMMUNICATION_TASK_RECIPIENT_REJECTED eventId=${input.event.id} ` +
    `scenario=${input.event.scenario} reason=${reason} source=${source}`,
  );
}

async function recordRecipientDiagnostic(
  input: Parameters<typeof resolveCommunicationEventRecipients>[0],
  status: CommunicationDiagnosticStatus,
  reasonCode: string,
  recipientSource = TASK_RECIPIENT_SOURCE,
): Promise<void> {
  if (!input.diagnostics) return;
  const snapshot = isObject(input.event.eventSnapshot) ? input.event.eventSnapshot : {};
  await input.diagnostics.record({
    sourceEntityType: input.event.sourceEntityType,
    sourceRecordId: input.event.sourceRecordId,
    businessNumber: snapshotString(snapshot, "taskNumber") ?? snapshotString(snapshot, "businessNumber"),
    scenario: input.event.scenario,
    status,
    reasonCode,
    reasonOrigin: CommunicationDiagnosticOrigin.APPLICATION,
    missingData: { recipientSource },
    checkedAt: (input.now ?? (() => new Date()))(),
    eventId: input.event.id,
  });
}

function createDebugTrace(event: RecipientResolutionEvent): RecipientResolutionDebugTrace {
  const snapshot = isObject(event.eventSnapshot) ? event.eventSnapshot : {};
  const task = event.sourceEntityType === CommunicationSourceEntityType.TASK;
  const sourceFields: RecipientDebugField[] = task
    ? [
        debugField("TASK_FIELDS.emmaRecipientEmail", TASK_FIELDS.emmaRecipientEmail,
          "EMMA: mail DT", snapshot.emmaRecipientEmail),
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
    ...(task ? {
      taskRecipientResolution: {
        source: "EVENT_SNAPSHOT" as const,
        airtableRefetched: false,
        refetchedAt: null,
      },
    } : {
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

function snapshotString(snapshot: unknown, key: string): string | null {
  if (!isObject(snapshot)) return null;
  const value = snapshot[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function recipientResolutionBackoffSeconds(attemptCount: number): number {
  return Math.min(15 * 2 ** Math.max(0, attemptCount - 1), 15 * 60);
}
