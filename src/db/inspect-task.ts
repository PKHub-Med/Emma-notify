import "dotenv/config";
import { AirtableClient } from "../airtable/client.js";
import {
  AIRTABLE_TABLE_IDS,
  CONTACT_FIELD_IDS,
  HOSPITAL_FIELDS,
  INSPECTION_FIELD_IDS,
  TASK_FIELD_IDS,
} from "../airtable/field-ids.js";
import { mapInspection } from "../airtable/mappers.js";
import { mapContact, resolveRecipient } from "../airtable/recipient.js";
import { mapTask } from "../airtable/task.js";
import { resolveCommunicationScenario } from "../airtable/template-scenario.js";
import { toLinkedRecordIds } from "../airtable/values.js";
import { loadWorkerConfig } from "../config/worker.js";
import {
  CaseType,
  CommunicationDeliveryStatus,
  CommunicationScenario,
  CommunicationSourceEntityType,
} from "../generated/prisma/enums.js";
import { buildTaskObservation } from "../worker/communication-event.js";
import {
  buildCommunicationTemplatePayload,
  CommunicationTemplateDataError,
  PrismaCommunicationTemplateDataSource,
} from "../worker/communication-template-data.js";
import { createPrismaClient } from "./prisma.js";

const taskRecordId = (process.env.TASK_RECORD_ID ?? process.argv[2] ?? "").trim();
if (!/^rec[A-Za-z0-9]+$/.test(taskRecordId)) {
  console.error(
    "Usage: $env:TASK_RECORD_ID='recXXXXXXXX'; npm run db:inspect-task",
  );
  process.exit(1);
}

const config = loadWorkerConfig(process.env);
const prisma = createPrismaClient(config.databaseUrl);
const airtable = new AirtableClient({
  baseId: config.airtableBaseId,
  personalAccessToken: config.airtablePat,
});

async function main(): Promise<void> {
  const airtableTaskRecord = await airtable.fetchRecord(
    AIRTABLE_TABLE_IDS.tasks,
    taskRecordId,
    TASK_FIELD_IDS,
  );
  const task = mapTask(airtableTaskRecord);
  const resolvedScenario = resolveCommunicationScenario({
    sourceEntityType: "TASK",
    emmaCustomerStatus: task.emmaCustomerStatus,
    emmaMailTemplate: task.emmaMailTemplate,
  });
  const currentObservation = buildTaskObservation(task, new Date());

  const [trackedTask, cursor, events, persistedInspections] = await Promise.all([
    prisma.trackedTask.findUnique({
      where: { airtableRecordId: taskRecordId },
    }),
    prisma.communicationCursor.findUnique({
      where: {
        sourceEntityType_sourceRecordId: {
          sourceEntityType: CommunicationSourceEntityType.TASK,
          sourceRecordId: taskRecordId,
        },
      },
    }),
    prisma.communicationEvent.findMany({
      where: {
        sourceEntityType: CommunicationSourceEntityType.TASK,
        sourceRecordId: taskRecordId,
      },
      orderBy: [{ detectedAt: "asc" }, { id: "asc" }],
      include: {
        recipients: { orderBy: { createdAt: "asc" } },
        deliveries: {
          orderBy: { createdAt: "asc" },
          include: { communicationEventRecipient: true },
        },
      },
    }),
    prisma.trackedCase.findMany({
      where: {
        caseType: CaseType.INSPECTION,
        airtableRecordId: { in: task.linkedInspectionRecordIds },
      },
      orderBy: { airtableRecordId: "asc" },
    }),
  ]);

  const contacts = await inspectContacts(task);
  const persistedById = new Map(
    persistedInspections.map((inspection) => [inspection.airtableRecordId, inspection]),
  );
  const inspections = await Promise.all(task.linkedInspectionRecordIds.map(async (recordId) => {
    const persisted = persistedById.get(recordId) ?? null;
    try {
      const record = await airtable.fetchRecord(
        AIRTABLE_TABLE_IDS.inspections,
        recordId,
        INSPECTION_FIELD_IDS,
      );
      const mapped = mapInspection(record);
      return {
        airtableRecordId: recordId,
        airtableRead: "OK",
        requiredForInspectionSummary: {
          liveAirtable: summaryInspection(mapped, persisted?.sourceHospitalRecordId ?? null),
          persistedBuilderInput: persisted ? summaryPersistedInspection(persisted) : null,
        },
        persistence: persisted
          ? { active: persisted.active, lastSeenAt: persisted.lastSeenAt }
          : null,
      };
    } catch (error: unknown) {
      return {
        airtableRecordId: recordId,
        airtableRead: "FAILED",
        airtableError: errorMessage(error),
        requiredForInspectionSummary: {
          liveAirtable: null,
          persistedBuilderInput: persisted ? summaryPersistedInspection(persisted) : null,
        },
        persistence: persisted
          ? { active: persisted.active, lastSeenAt: persisted.lastSeenAt }
          : null,
      };
    }
  }));

  const completedEvent = [...events].reverse().find(
    (event) => event.scenario === CommunicationScenario.INSPECTION_COMPLETED,
  ) ?? null;
  const payloadSource = completedEvent
    ? {
        origin: "LATEST_INSPECTION_COMPLETED_EVENT" as const,
        id: completedEvent.deliveries[0]?.id ?? `diagnostic:${taskRecordId}`,
        scenario: completedEvent.scenario,
        sourceRecordId: completedEvent.sourceRecordId,
        eventSnapshot: completedEvent.eventSnapshot,
      }
    : {
        origin: "CURRENT_AIRTABLE_TASK_FORCED_TO_INSPECTION_COMPLETED" as const,
        id: `diagnostic:${taskRecordId}`,
        scenario: CommunicationScenario.INSPECTION_COMPLETED,
        sourceRecordId: taskRecordId,
        eventSnapshot: {
          ...currentObservation.eventSnapshot,
          scenario: CommunicationScenario.INSPECTION_COMPLETED,
        },
      };
  const payloadBuild = await inspectPayloadBuild(payloadSource);

  const eventReport = events.map((event) => ({
    id: event.id,
    scenario: event.scenario,
    eventSnapshot: event.eventSnapshot,
    detectedAt: event.detectedAt,
    createdAt: event.createdAt,
    processedAt: event.processedAt,
    recipientsResolvedAt: event.recipientsResolvedAt,
    recipientResolutionAttemptCount: event.recipientResolutionAttemptCount,
    nextRecipientResolutionAt: event.nextRecipientResolutionAt,
    recipients: event.recipients.map((recipient) => ({
      id: recipient.id,
      recipientType: recipient.recipientType,
      sourceContactRecordId: recipient.sourceContactRecordId,
      email: maskEmail(recipient.email),
      normalizedEmail: maskEmail(recipient.normalizedEmail),
      resolutionStatus: recipient.resolutionStatus,
      resolutionReason: recipient.resolutionReason,
      createdAt: recipient.createdAt,
    })),
    deliveries: event.deliveries.map((delivery) => ({
      id: delivery.id,
      recipient: {
        id: delivery.communicationEventRecipient.id,
        recipientType: delivery.communicationEventRecipient.recipientType,
        sourceContactRecordId: delivery.communicationEventRecipient.sourceContactRecordId,
        email: maskEmail(delivery.communicationEventRecipient.email),
        resolutionStatus: delivery.communicationEventRecipient.resolutionStatus,
        resolutionReason: delivery.communicationEventRecipient.resolutionReason,
      },
      status: delivery.status,
      blockReason: deliveryBlockReason(delivery),
      cancelReason: delivery.cancelReason,
      lastError: delivery.lastError,
      scheduleReason: delivery.scheduleReason,
      scheduledFor: delivery.scheduledFor,
      readyAt: delivery.readyAt,
      attemptCount: delivery.attemptCount,
      nextRetryAt: delivery.nextRetryAt,
      createdAt: delivery.createdAt,
      updatedAt: delivery.updatedAt,
      sentAt: delivery.sentAt,
      failedAt: delivery.failedAt,
      sendingStartedAt: delivery.sendingStartedAt,
      preparedAt: delivery.preparedAt,
      resendMessageId: delivery.resendMessageId,
      emailMode: delivery.emailMode,
      actualRecipientEmail: maskEmail(delivery.actualRecipientEmail),
      sendSnapshot: delivery.sendSnapshot,
    })),
    pipelineReason: eventPipelineReason(event),
  }));

  const likelyNotSentReasons = collectNotSentReasons({
    resolvedScenario,
    trackedTask,
    events: eventReport,
    payloadBuild,
  });

  console.info(JSON.stringify({
    mode: "READ_ONLY",
    task: {
      airtableRecordId: task.airtableRecordId,
      emmaCustomerStatus: task.emmaCustomerStatus,
      emmaMailTemplate: task.emmaMailTemplate,
      sourceHospitalRecordId: task.sourceHospitalRecordId,
      primaryContactRecordIds: task.selectedContactRecordIds,
      fallbackContactRecordIds: task.hospitalContactRecordIds,
      linkedInspectionRecordIds: task.linkedInspectionRecordIds,
      day: task.day,
      completed: task.completed,
      status: task.status,
    },
    contacts,
    scenarioResolution: {
      recognizedScenario: resolvedScenario,
      isInspectionCompleted: resolvedScenario === CommunicationScenario.INSPECTION_COMPLETED,
      expectedForSummary: {
        emmaCustomerStatus: "Wizyta zakończona",
        emmaMailTemplate: "Przegląd-podsumowanie_wizyty",
      },
    },
    trackedTask: trackedTask ? {
      ...trackedTask,
      selectedContactRecordIds: jsonStringArray(trackedTask.selectedContactRecordIds),
      linkedInspectionRecordIds: jsonStringArray(trackedTask.linkedInspectionRecordIds),
      linkedServiceOrderRecordIds: jsonStringArray(trackedTask.linkedServiceOrderRecordIds),
      performerRecordIds: jsonStringArray(trackedTask.performerRecordIds),
    } : null,
    communicationCursor: cursor,
    inspections,
    communicationEvents: eventReport,
    emailSenderBarriers: {
      communicationEmailsEnabled: config.communicationEmailsEnabled,
      communicationSendNotBefore: config.communicationSendNotBefore,
      emailMode: config.emailMode,
      productionEmailsEnabled: config.productionEmailsEnabled,
      resendApiKeyConfigured: Boolean(config.resendApiKey),
      blockingReasons: emailSenderBarrierReasons(),
    },
    payloadBuild,
    likelyNotSentReasons,
  }, null, 2));
}

async function inspectContacts(task: ReturnType<typeof mapTask>) {
  let hospitalContactIds: string[] = [];
  let hospitalScopeReadError: string | null = null;
  if (task.sourceHospitalRecordId) {
    try {
      const hospital = await airtable.fetchRecord(
        AIRTABLE_TABLE_IDS.hospitals,
        task.sourceHospitalRecordId,
        [HOSPITAL_FIELDS.contactLinks],
      );
      hospitalContactIds = toLinkedRecordIds(hospital.fields[HOSPITAL_FIELDS.contactLinks]);
    } catch (error: unknown) {
      hospitalScopeReadError = errorMessage(error);
    }
  }
  const allowedFallbackIds = new Set(hospitalContactIds);

  const primary = await Promise.all(task.selectedContactRecordIds.map((id) =>
    inspectContact(id, true, task.sourceHospitalRecordId)));
  const fallback = await Promise.all(task.hospitalContactRecordIds.map((id) =>
    inspectContact(id, allowedFallbackIds.has(id), task.sourceHospitalRecordId)));
  const selected = primary.filter((contact) => contact.eligible);
  const selectedSource = selected.length > 0 ? "PRIMARY" : "FALLBACK";
  const selectedContacts = selected.length > 0
    ? selected
    : fallback.filter((contact) => contact.eligible);

  return {
    hospitalScopeReadError,
    hospitalContactRecordIds: hospitalContactIds,
    primary,
    fallback,
    selection: {
      source: selectedContacts.length > 0 ? selectedSource : "NO_VALID_CLIENT_RECIPIENT",
      contactRecordIds: selectedContacts.map((contact) => contact.airtableRecordId),
    },
  };
}

async function inspectContact(
  recordId: string,
  hospitalScopeMatch: boolean,
  sourceHospitalRecordId: string | null,
) {
  try {
    const record = await airtable.fetchRecord(
      AIRTABLE_TABLE_IDS.contacts,
      recordId,
      CONTACT_FIELD_IDS,
    );
    const resolved = resolveRecipient(recordId, mapContact(record));
    const optedOut = Boolean(
      resolved.normalizedEmail && sourceHospitalRecordId &&
      await prisma.communicationOptOut.findUnique({
        where: {
          sourceHospitalRecordId_normalizedEmail: {
            sourceHospitalRecordId,
            normalizedEmail: resolved.normalizedEmail,
          },
        },
        select: { id: true },
      }),
    );
    const eligible = resolved.eligible && hospitalScopeMatch && !optedOut;
    return {
      airtableRecordId: recordId,
      hospitalScopeMatch,
      optedOut,
      eligible,
      eligibilityReason: !hospitalScopeMatch
        ? "HOSPITAL_SCOPE_MISMATCH"
        : optedOut ? "OPTED_OUT" : resolved.eligibilityReason,
      email: maskEmail(resolved.email),
      normalizedEmail: maskEmail(resolved.normalizedEmail),
      hasEmail: resolved.email !== null,
    };
  } catch (error: unknown) {
    return {
      airtableRecordId: recordId,
      hospitalScopeMatch,
      eligible: false,
      eligibilityReason: "AIRTABLE_CONTACT_READ_FAILED",
      error: errorMessage(error),
    };
  }
}

function summaryInspection(
  mapped: ReturnType<typeof mapInspection>,
  sourceHospitalRecordId: string | null,
) {
  return {
    airtableRecordId: mapped.airtableRecordId,
    sourceHospitalRecordId,
    currentStatus: mapped.currentStatus,
    inspectionPerformedAt: mapped.inspectionPerformedAt,
    inspectionResult: mapped.inspectionResult,
    inspectionDueDate: mapped.inspectionDueDate,
    businessNumber: mapped.businessNumber,
    clientOrderNumber: mapped.clientOrderNumber,
    deviceName: mapped.deviceName,
    manufacturer: mapped.manufacturer,
    model: mapped.model,
    serialNumber: mapped.serialNumber,
    inventoryNumber: mapped.inventoryNumber,
    estimatedDurationSeconds: snapshotNumber(mapped.sourceSnapshot, "estimatedDurationSeconds"),
  };
}

function summaryPersistedInspection(inspection: {
  airtableRecordId: string;
  sourceHospitalRecordId: string | null;
  currentStatus: string | null;
  inspectionPerformedAt: Date | null;
  inspectionResult: string | null;
  inspectionDueDate: Date | null;
  businessNumber: string | null;
  clientOrderNumber: string | null;
  deviceName: string | null;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  inventoryNumber: string | null;
  sourceSnapshot: unknown;
}) {
  return {
    airtableRecordId: inspection.airtableRecordId,
    sourceHospitalRecordId: inspection.sourceHospitalRecordId,
    currentStatus: inspection.currentStatus,
    inspectionPerformedAt: inspection.inspectionPerformedAt,
    inspectionResult: inspection.inspectionResult,
    inspectionDueDate: inspection.inspectionDueDate,
    businessNumber: inspection.businessNumber,
    clientOrderNumber: inspection.clientOrderNumber,
    deviceName: inspection.deviceName,
    manufacturer: inspection.manufacturer,
    model: inspection.model,
    serialNumber: inspection.serialNumber,
    inventoryNumber: inspection.inventoryNumber,
    estimatedDurationSeconds: snapshotNumber(inspection.sourceSnapshot, "estimatedDurationSeconds"),
  };
}

async function inspectPayloadBuild(delivery: {
  origin: string;
  id: string;
  scenario: CommunicationScenario;
  sourceRecordId: string;
  eventSnapshot: unknown;
}) {
  try {
    const payload = await buildCommunicationTemplatePayload({
      delivery,
      dataSource: new PrismaCommunicationTemplateDataSource(prisma, airtable),
      secureUrl: "https://diagnostic.invalid/portal",
      unsubscribeUrl: "https://diagnostic.invalid/unsubscribe",
      preparedAt: new Date(),
      timeZone: config.communicationTimezone,
      officeContact: {
        name: config.tiemedOfficeName,
        phone: config.tiemedOfficePhone,
        email: config.tiemedOfficeEmail,
      },
    });
    return {
      origin: delivery.origin,
      succeeded: true,
      templateId: payload.templateId,
      variableCount: Object.keys(payload.variables).length,
      nonEmptyVariables: Object.fromEntries(Object.entries(payload.variables)
        .filter(([, value]) => value !== "")),
    };
  } catch (error: unknown) {
    if (error instanceof CommunicationTemplateDataError) {
      return {
        origin: delivery.origin,
        succeeded: false,
        reason: error.code,
        retryable: error.retryable,
        diagnostic: error.diagnostic ?? null,
      };
    }
    return {
      origin: delivery.origin,
      succeeded: false,
      reason: "UNEXPECTED_PAYLOAD_BUILD_ERROR",
      error: errorMessage(error),
    };
  }
}

function deliveryBlockReason(delivery: {
  status: CommunicationDeliveryStatus;
  cancelReason: string | null;
  lastError: string | null;
  scheduledFor: Date;
  sendingStartedAt: Date | null;
}): string | null {
  if (delivery.status === CommunicationDeliveryStatus.READY ||
      delivery.status === CommunicationDeliveryStatus.SENT) return null;
  if (delivery.cancelReason) return delivery.cancelReason;
  if (delivery.lastError) return delivery.lastError;
  if (delivery.status === CommunicationDeliveryStatus.SCHEDULED) {
    return `SCHEDULED_UNTIL:${delivery.scheduledFor.toISOString()}`;
  }
  if (delivery.status === CommunicationDeliveryStatus.SENDING) {
    return `SENDING_SINCE:${delivery.sendingStartedAt?.toISOString() ?? "UNKNOWN"}`;
  }
  return `${delivery.status}_WITHOUT_RECORDED_REASON`;
}

function eventPipelineReason(event: {
  recipientsResolvedAt: Date | null;
  processedAt: Date | null;
  recipients: Array<{ resolutionStatus: string; resolutionReason: string | null }>;
  deliveries: unknown[];
}): string | null {
  if (!event.recipientsResolvedAt) return "RECIPIENTS_NOT_RESOLVED";
  const deliverable = event.recipients.some((recipient) =>
    recipient.resolutionStatus === "READY" || recipient.resolutionStatus === "FALLBACK");
  if (!deliverable) {
    const reasons = [...new Set(event.recipients.map((recipient) =>
      recipient.resolutionReason).filter(Boolean))];
    return `NO_DELIVERABLE_RECIPIENT:${reasons.join(",") || "NO_RECIPIENT_ROWS"}`;
  }
  if (event.deliveries.length === 0) {
    return event.processedAt ? "EVENT_PROCESSED_WITHOUT_DELIVERY" : "DELIVERY_NOT_PLANNED";
  }
  return null;
}

function emailSenderBarrierReasons(): string[] {
  const reasons: string[] = [];
  if (!config.communicationEmailsEnabled) reasons.push("COMMUNICATION_EMAILS_DISABLED");
  if (!config.communicationSendNotBefore) reasons.push("SEND_NOT_BEFORE_INVALID");
  if (config.emailMode === "PRODUCTION" && !config.productionEmailsEnabled) {
    reasons.push("PRODUCTION_EMAILS_BLOCKED");
  }
  if (!config.resendApiKey) reasons.push("RESEND_API_KEY_MISSING");
  return reasons;
}

function collectNotSentReasons(input: {
  resolvedScenario: string | null;
  trackedTask: unknown;
  events: Array<{
    scenario: string;
    pipelineReason: string | null;
    deliveries: Array<{ status: CommunicationDeliveryStatus; blockReason: string | null }>;
  }>;
  payloadBuild: { succeeded: boolean; reason?: string };
}): string[] {
  const reasons: string[] = [];
  if (!input.trackedTask) reasons.push("TASK_NOT_PERSISTED");
  if (input.resolvedScenario !== CommunicationScenario.INSPECTION_COMPLETED) {
    reasons.push(`TASK_NOT_RECOGNIZED_AS_INSPECTION_COMPLETED:${input.resolvedScenario ?? "NO_SCENARIO"}`);
  }
  const completedEvents = input.events.filter((event) =>
    event.scenario === CommunicationScenario.INSPECTION_COMPLETED);
  if (completedEvents.length === 0) reasons.push("NO_INSPECTION_COMPLETED_COMMUNICATION_EVENT");
  for (const event of completedEvents) {
    if (event.pipelineReason) reasons.push(event.pipelineReason);
    if (event.deliveries.length === 0) reasons.push("NO_COMMUNICATION_DELIVERY");
    for (const delivery of event.deliveries) {
      if (delivery.blockReason) reasons.push(delivery.blockReason);
      if (delivery.status === CommunicationDeliveryStatus.READY) {
        reasons.push(...emailSenderBarrierReasons());
        if (emailSenderBarrierReasons().length === 0) reasons.push("READY_AWAITING_EMAIL_WORKER");
      }
    }
  }
  if (!input.payloadBuild.succeeded) {
    reasons.push(`PAYLOAD_BUILD_FAILED:${input.payloadBuild.reason ?? "UNKNOWN"}`);
  }
  return [...new Set(reasons)];
}

function snapshotNumber(snapshot: unknown, key: string): number | null {
  if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) return null;
  const value = (snapshot as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function jsonStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function maskEmail(value: string | null): string | null {
  if (!value) return null;
  const at = value.indexOf("@");
  if (at < 1) return "***";
  return `${value.slice(0, 1)}***${value.slice(at)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "UNKNOWN_ERROR";
}

main()
  .catch((error: unknown) => {
    console.error(JSON.stringify({
      mode: "READ_ONLY",
      taskRecordId,
      diagnosticFailed: true,
      error: errorMessage(error),
    }, null, 2));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
