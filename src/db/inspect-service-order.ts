import "dotenv/config";
import { AirtableClient } from "../airtable/client.js";
import {
  AIRTABLE_TABLE_IDS,
  SERVICE_ORDER_FIELD_IDS,
  SERVICE_ORDER_FIELDS,
} from "../airtable/field-ids.js";
import { mapServiceOrder } from "../airtable/mappers.js";
import { resolveCommunicationScenario } from "../airtable/template-scenario.js";
import type { AirtableRecord } from "../airtable/types.js";
import { loadWorkerConfig } from "../config/worker.js";
import {
  CaseType,
  CommunicationScenario,
  CommunicationSourceEntityType,
} from "../generated/prisma/enums.js";
import {
  buildCommunicationRepairBatchPayload,
  buildCommunicationTemplatePayload,
  CommunicationTemplateDataError,
  type TemplateDelivery,
} from "../worker/communication-template-data.js";
import { createPrismaClient } from "./prisma.js";

export type RepairBatchMissingDiagnostic = {
  reason: "EMPTY_REPAIR_BATCH" | null;
  missing: Array<{
    sourceRecordId: string;
    missingField: "businessNumber" | "device.name";
  }>;
};

export function diagnoseRepairBatchInput(
  deliveries: readonly Pick<TemplateDelivery, "sourceRecordId" | "eventSnapshot">[],
): RepairBatchMissingDiagnostic {
  if (deliveries.length === 0) return { reason: "EMPTY_REPAIR_BATCH", missing: [] };
  const missing: RepairBatchMissingDiagnostic["missing"] = [];
  for (const delivery of deliveries) {
    const snapshot = object(delivery.eventSnapshot);
    const device = object(snapshot.device);
    if (!hasDisplayValue(snapshot.businessNumber)) {
      missing.push({ sourceRecordId: delivery.sourceRecordId, missingField: "businessNumber" });
    }
    if (!hasDisplayValue(device.name)) {
      missing.push({ sourceRecordId: delivery.sourceRecordId, missingField: "device.name" });
    }
  }
  return { reason: null, missing };
}

async function main(): Promise<void> {
  const serviceOrderNumber = (
    process.env.SERVICE_ORDER_NUMBER ?? process.argv[2] ?? ""
  ).trim().replace(/^#/, "");
  if (!serviceOrderNumber) {
    console.error(
      "Usage: $env:SERVICE_ORDER_NUMBER='24928'; npm run db:inspect-service-order",
    );
    process.exitCode = 1;
    return;
  }

  const config = loadWorkerConfig(process.env);
  const prisma = createPrismaClient(config.databaseUrl);
  const airtable = new AirtableClient({
    baseId: config.airtableBaseId,
    personalAccessToken: config.airtablePat,
  });

  try {
    const formulaValue = serviceOrderNumber.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
    const airtableRecords = await airtable.fetchAllRecords(
      AIRTABLE_TABLE_IDS.serviceOrders,
      SERVICE_ORDER_FIELD_IDS,
      {
        filterByFormula:
          `TRIM({${SERVICE_ORDER_FIELDS.businessNumber}} & '') = '${formulaValue}'`,
      },
    );
    const currentById = new Map(airtableRecords.map((record) => [record.id, mapServiceOrder(record)]));
    const trackedOrders = await prisma.trackedCase.findMany({
      where: { caseType: CaseType.SERVICE_ORDER, businessNumber: serviceOrderNumber },
      orderBy: { airtableRecordId: "asc" },
    });
    const trackedById = new Map(trackedOrders.map((order) => [order.airtableRecordId, order]));
    const sourceRecordIds = [...new Set([
      ...currentById.keys(),
      ...trackedById.keys(),
    ])];
    const events = sourceRecordIds.length === 0 ? [] : await prisma.communicationEvent.findMany({
      where: {
        sourceEntityType: CommunicationSourceEntityType.SERVICE_ORDER,
        sourceRecordId: { in: sourceRecordIds },
      },
      orderBy: [{ detectedAt: "asc" }, { id: "asc" }],
      include: {
        recipients: { orderBy: { createdAt: "asc" } },
        deliveries: {
          orderBy: { createdAt: "asc" },
          include: { communicationEventRecipient: true },
        },
      },
    });

    const reports = [];
    for (const sourceRecordId of sourceRecordIds) {
      const current = currentById.get(sourceRecordId) ?? null;
      const tracked = trackedById.get(sourceRecordId) ?? null;
      const orderEvents = events.filter((event) => event.sourceRecordId === sourceRecordId);
      const receivedEvents = orderEvents.filter((event) =>
        event.scenario === CommunicationScenario.REPAIR_RECEIVED);
      const currentScenario = current ? resolveCommunicationScenario({
        sourceEntityType: "SERVICE_ORDER",
        emmaCustomerStatus: current.emmaCustomerStatus,
        emmaMailTemplate: current.emmaMailTemplate,
      }) : null;
      const trackedScenario = tracked ? resolveCommunicationScenario({
        sourceEntityType: "SERVICE_ORDER",
        emmaCustomerStatus: tracked.emmaCustomerStatus,
        emmaMailTemplate: tracked.emmaMailTemplate,
      }) : null;

      const eventReports = [];
      for (const event of orderEvents) {
        const deliveryReports = [];
        for (const delivery of event.deliveries) {
          const reconstructedBatch = event.scenario === CommunicationScenario.REPAIR_RECEIVED
            ? await reconstructRepairBatch(prisma, {
                ...delivery,
                communicationEvent: { eventSnapshot: event.eventSnapshot },
              })
            : [];
          const batchDeliveries = reconstructedBatch.map((item) => ({
            id: item.id,
            scenario: item.scenario,
            sourceRecordId: item.communicationEvent.sourceRecordId,
            eventSnapshot: item.communicationEvent.eventSnapshot,
          }));
          const singleBuild = event.scenario === CommunicationScenario.REPAIR_RECEIVED
            ? await trySinglePayloadBuild({
                id: delivery.id,
                scenario: event.scenario,
                sourceRecordId: event.sourceRecordId,
                eventSnapshot: event.eventSnapshot,
              }, config.communicationTimezone)
            : null;
          const batchBuild = event.scenario === CommunicationScenario.REPAIR_RECEIVED
            ? await tryBatchPayloadBuild(batchDeliveries, config.communicationTimezone)
            : null;
          deliveryReports.push({
            id: delivery.id,
            status: delivery.status,
            recipient: {
              recipientType: delivery.communicationEventRecipient.recipientType,
              sourceContactRecordId: delivery.communicationEventRecipient.sourceContactRecordId,
              email: maskEmail(delivery.communicationEventRecipient.email),
              resolutionStatus: delivery.communicationEventRecipient.resolutionStatus,
              resolutionReason: delivery.communicationEventRecipient.resolutionReason,
            },
            originalScenario: delivery.scenario,
            cancelReason: delivery.cancelReason,
            lastError: delivery.lastError,
            attemptCount: delivery.attemptCount,
            createdAt: delivery.createdAt,
            scheduledFor: delivery.scheduledFor,
            readyAt: delivery.readyAt,
            sendingStartedAt: delivery.sendingStartedAt,
            preparedAt: delivery.preparedAt,
            failedAt: delivery.failedAt,
            sentAt: delivery.sentAt,
            updatedAt: delivery.updatedAt,
            diagnosticFallback: diagnosticFallback(delivery),
            reconstructedRepairBatch: {
              isEmpty: batchDeliveries.length === 0,
              deliveryIds: batchDeliveries.map((item) => item.id),
              sourceRecordIds: batchDeliveries.map((item) => item.sourceRecordId),
              reconstructionKey: repairBatchKey({
                ...delivery,
                communicationEvent: { eventSnapshot: event.eventSnapshot },
              }),
              note: "Reconstructed from persisted scenario/scheduledFor/hospital/recipient; the exact historical candidate set is not stored separately.",
            },
            buildCommunicationTemplatePayload: singleBuild,
            buildCommunicationRepairBatchPayload: batchBuild,
          });
        }
        eventReports.push({
          id: event.id,
          scenario: event.scenario,
          eventSnapshot: event.eventSnapshot,
          snapshotRequiredFields: snapshotRequiredFields(event.eventSnapshot),
          detectedAt: event.detectedAt,
          createdAt: event.createdAt,
          processedAt: event.processedAt,
          recipientsResolvedAt: event.recipientsResolvedAt,
          recipients: event.recipients.map((recipient) => ({
            id: recipient.id,
            recipientType: recipient.recipientType,
            sourceContactRecordId: recipient.sourceContactRecordId,
            email: maskEmail(recipient.email),
            resolutionStatus: recipient.resolutionStatus,
            resolutionReason: recipient.resolutionReason,
            createdAt: recipient.createdAt,
          })),
          deliveries: deliveryReports,
        });
      }

      reports.push({
        serviceOrderNumber,
        sourceRecordId,
        airtableCurrentData: current ? {
          businessNumber: current.businessNumber,
          deviceName: current.deviceName,
          emmaCustomerStatus: current.emmaCustomerStatus,
          emmaMailTemplate: current.emmaMailTemplate,
          sourceHospitalRecordId: current.sourceHospitalRecordId,
          resolvedScenario: currentScenario,
        } : null,
        trackedLocalData: tracked ? {
          businessNumber: tracked.businessNumber,
          deviceName: tracked.deviceName,
          emmaCustomerStatus: tracked.emmaCustomerStatus,
          emmaMailTemplate: tracked.emmaMailTemplate,
          sourceHospitalRecordId: tracked.sourceHospitalRecordId,
          sourceCreatedAt: tracked.sourceCreatedAt,
          firstSeenAt: tracked.firstSeenAt,
          lastSeenAt: tracked.lastSeenAt,
          resolvedScenario: trackedScenario,
        } : null,
        communicationEvents: eventReports,
        diagnosis: summarizeDiagnosis({
          serviceOrderNumber,
          currentScenario,
          receivedEvents: eventReports.filter((event) =>
            event.scenario === CommunicationScenario.REPAIR_RECEIVED),
        }),
      });
    }

    console.info(JSON.stringify({
      mode: "READ_ONLY",
      serviceOrderNumber,
      matchCount: reports.length,
      ambiguousBusinessNumber: reports.length > 1,
      noMatch: reports.length === 0,
      reports,
    }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

async function reconstructRepairBatch(
  prisma: ReturnType<typeof createPrismaClient>,
  target: {
    scenario: CommunicationScenario;
    scheduledFor: Date;
    communicationEvent: { eventSnapshot: unknown };
    communicationEventRecipient: { normalizedEmail: string | null; email: string | null };
  },
) {
  const hospital = snapshotString(target.communicationEvent.eventSnapshot, "sourceHospitalRecordId");
  const recipient = normalizedRecipient(target.communicationEventRecipient);
  const candidates = await prisma.communicationDelivery.findMany({
    where: {
      scenario: target.scenario,
      scheduledFor: target.scheduledFor,
    },
    orderBy: { id: "asc" },
    include: {
      communicationEvent: true,
      communicationEventRecipient: true,
    },
  });
  return candidates.filter((candidate) =>
    snapshotString(candidate.communicationEvent.eventSnapshot, "sourceHospitalRecordId") === hospital &&
    normalizedRecipient(candidate.communicationEventRecipient) === recipient);
}

async function trySinglePayloadBuild(delivery: TemplateDelivery, timeZone: string) {
  const inputDiagnostic = diagnoseRepairBatchInput([delivery]);
  try {
    const payload = await buildCommunicationTemplatePayload({
      delivery,
      dataSource: emptyTemplateDataSource,
      secureUrl: "https://diagnostic.invalid/portal",
      unsubscribeUrl: "https://diagnostic.invalid/unsubscribe",
      preparedAt: new Date(),
      timeZone,
    });
    return payloadSuccess(payload, inputDiagnostic);
  } catch (error: unknown) {
    return payloadFailure(error, inputDiagnostic);
  }
}

async function tryBatchPayloadBuild(deliveries: TemplateDelivery[], timeZone: string) {
  const inputDiagnostic = diagnoseRepairBatchInput(deliveries);
  try {
    const payload = await buildCommunicationRepairBatchPayload({
      deliveries,
      dataSource: emptyTemplateDataSource,
      secureUrl: "https://diagnostic.invalid/portal",
      unsubscribeUrl: "https://diagnostic.invalid/unsubscribe",
      preparedAt: new Date(),
      timeZone,
    });
    return payloadSuccess(payload, inputDiagnostic);
  } catch (error: unknown) {
    return payloadFailure(error, inputDiagnostic);
  }
}

function payloadSuccess(
  payload: { templateId: string; variables: Record<string, string | number> },
  inputDiagnostic: RepairBatchMissingDiagnostic,
) {
  return {
    succeeded: true as const,
    templateId: payload.templateId,
    subject: payload.variables.EMAIL_TITLE ?? null,
    inputDiagnostic,
  };
}

function payloadFailure(error: unknown, inputDiagnostic: RepairBatchMissingDiagnostic) {
  if (error instanceof CommunicationTemplateDataError) {
    const firstMissing = inputDiagnostic.missing[0];
    return {
      succeeded: false as const,
      reason: error.code,
      ...(error.code === "TEMPLATE_DATA_MISSING" && inputDiagnostic.reason
        ? { detail: { reason: inputDiagnostic.reason } }
        : error.code === "TEMPLATE_DATA_MISSING" && firstMissing
          ? { detail: firstMissing }
          : {}),
      retryable: error.retryable,
      inputDiagnostic,
    };
  }
  return {
    succeeded: false as const,
    reason: "UNEXPECTED_PAYLOAD_BUILD_ERROR",
    error: errorMessage(error),
    inputDiagnostic,
  };
}

function diagnosticFallback(delivery: {
  id: string;
  scenario: CommunicationScenario;
  lastError: string | null;
  sendingStartedAt: Date | null;
  sentAt: Date | null;
  failedAt: Date | null;
  updatedAt: Date;
  communicationEventRecipient: {
    recipientType: string;
    resolutionReason: string | null;
  };
}) {
  const originalError = delivery.communicationEventRecipient.resolutionReason ??
    delivery.lastError?.replace(/^BLOCKED_CLIENT:/, "") ?? null;
  const isDiagnostic = delivery.communicationEventRecipient.recipientType === "TIEMED_FALLBACK" &&
    Boolean(delivery.lastError?.startsWith("BLOCKED_CLIENT:") || originalError);
  return isDiagnostic ? {
    found: true,
    communicationDeliveryId: delivery.id,
    emailTitle: "EMMA — wiadomość wymaga ręcznej obsługi",
    fallbackReason: delivery.communicationEventRecipient.resolutionReason,
    originalScenario: delivery.scenario,
    originalError,
    exactFallbackTimestamp: null,
    timestampNote: "rerouteToFallback does not persist a separate timestamp",
    fallbackWindowStart: delivery.sendingStartedAt,
    diagnosticMailFinishedAt: delivery.sentAt ?? delivery.failedAt ?? delivery.updatedAt,
  } : { found: false };
}

function summarizeDiagnosis(input: {
  serviceOrderNumber: string;
  currentScenario: string | null;
  receivedEvents: Array<{
    eventSnapshot: unknown;
    deliveries: Array<{
      buildCommunicationRepairBatchPayload: ReturnType<typeof payloadSuccess> |
        ReturnType<typeof payloadFailure> | null;
      diagnosticFallback: ReturnType<typeof diagnosticFallback>;
    }>;
  }>;
}) {
  const event = input.receivedEvents.at(-1) ?? null;
  const snapshot = object(event?.eventSnapshot);
  const device = object(snapshot.device);
  const delivery = event?.deliveries.at(-1) ?? null;
  const build = delivery?.buildCommunicationRepairBatchPayload ?? null;
  return {
    label: `#${input.serviceOrderNumber}`,
    trigger: input.currentScenario === CommunicationScenario.REPAIR_RECEIVED ? "OK" : "FAIL",
    event: event ? "OK" : "FAIL",
    businessNumberSnapshot: snapshot.businessNumber ?? null,
    deviceNameSnapshot: device.name ?? null,
    templateBuild: build?.succeeded ? "OK" : build?.reason ?? "NOT_ATTEMPTED",
    rootCause: build && !build.succeeded
      ? ("detail" in build && build.detail ? build.detail : build.reason)
      : delivery?.diagnosticFallback.found
        ? delivery.diagnosticFallback.originalError
        : event ? "NO_BUILD_ERROR_REPRODUCED" : "NO_REPAIR_RECEIVED_EVENT",
  };
}

function snapshotRequiredFields(snapshotValue: unknown) {
  const snapshot = object(snapshotValue);
  const device = object(snapshot.device);
  return {
    businessNumber: snapshot.businessNumber ?? null,
    deviceName: device.name ?? null,
  };
}

function repairBatchKey(delivery: {
  scenario: CommunicationScenario;
  scheduledFor: Date;
  communicationEvent: { eventSnapshot: unknown };
  communicationEventRecipient: { normalizedEmail: string | null; email: string | null };
}) {
  return [
    delivery.scenario,
    delivery.scheduledFor.toISOString(),
    snapshotString(delivery.communicationEvent.eventSnapshot, "sourceHospitalRecordId") ?? "",
    normalizedRecipient(delivery.communicationEventRecipient),
  ].join("|");
}

function normalizedRecipient(recipient: { normalizedEmail: string | null; email: string | null }) {
  return (recipient.normalizedEmail ?? recipient.email ?? "").trim().toLowerCase();
}

const emptyTemplateDataSource = {
  async getEmployees() { return []; },
  async getInspections() { return []; },
  async getServiceOrders() { return []; },
};

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function hasDisplayValue(value: unknown): boolean {
  return typeof value === "string"
    ? value.replace(/[\r\n\t]+/g, " ").trim().length > 0
    : typeof value === "number";
}

function snapshotString(snapshot: unknown, key: string): string | null {
  const value = object(snapshot)[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function maskEmail(value: string | null): string | null {
  if (!value) return null;
  const at = value.indexOf("@");
  return at > 0 ? `${value.slice(0, 1)}***${value.slice(at)}` : "***";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "UNKNOWN_ERROR";
}

const isDirectRun = process.argv[1]?.replaceAll("\\", "/")
  .endsWith("/inspect-service-order.js");
if (isDirectRun) {
  main().catch((error: unknown) => {
    console.error(JSON.stringify({
      mode: "READ_ONLY",
      diagnosticFailed: true,
      error: errorMessage(error),
    }, null, 2));
    process.exitCode = 1;
  });
}
