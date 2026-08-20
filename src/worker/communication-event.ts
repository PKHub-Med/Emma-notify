import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import {
  CommunicationScenario as PrismaCommunicationScenario,
  CommunicationSourceEntityType as PrismaCommunicationSourceEntityType,
  SyncEntityType,
  SyncStatus,
} from "../generated/prisma/enums.js";
import type { MappedCase } from "../airtable/mappers.js";
import type { MappedTask } from "../airtable/task.js";
import {
  resolveCommunicationScenario,
  type CommunicationScenario,
  type CommunicationSourceEntityType,
} from "../airtable/template-scenario.js";

const COMMUNICATION_SYNC_SOURCE = "EMMA_COMMUNICATION";

export type CommunicationObservation = {
  sourceEntityType: CommunicationSourceEntityType;
  sourceRecordId: string;
  scenario: CommunicationScenario | null;
  signature: string;
  fingerprintPayload: readonly unknown[];
  eventSnapshot: Record<string, unknown>;
  unknownPair: boolean;
};

export type CommunicationObservationResult = {
  outcome: "CREATED" | "UNCHANGED" | "SUPPRESSED" | "NO_SCENARIO";
  revision: number;
  fingerprint?: string;
};

export interface CommunicationEventStore {
  isBaselineCompleted(sourceEntityType: CommunicationSourceEntityType): Promise<boolean>;
  markBaselineCompleted(
    sourceEntityType: CommunicationSourceEntityType,
    at: Date,
  ): Promise<void>;
  observe(
    observation: CommunicationObservation,
    allowEvent: boolean,
    detectedAt: Date,
  ): Promise<CommunicationObservationResult>;
}

export class PrismaCommunicationEventStore implements CommunicationEventStore {
  constructor(private readonly prisma: PrismaClient | Prisma.TransactionClient) {}

  async isBaselineCompleted(
    sourceEntityType: CommunicationSourceEntityType,
  ): Promise<boolean> {
    const state = await this.prisma.syncState.upsert({
      where: {
        source_entityType: {
          source: COMMUNICATION_SYNC_SOURCE,
          entityType: toSyncEntityType(sourceEntityType),
        },
      },
      create: {
        source: COMMUNICATION_SYNC_SOURCE,
        entityType: toSyncEntityType(sourceEntityType),
        status: SyncStatus.IDLE,
      },
      update: {},
      select: { baselineCompletedAt: true },
    });
    return state.baselineCompletedAt !== null;
  }

  async markBaselineCompleted(
    sourceEntityType: CommunicationSourceEntityType,
    at: Date,
  ): Promise<void> {
    await this.prisma.syncState.update({
      where: {
        source_entityType: {
          source: COMMUNICATION_SYNC_SOURCE,
          entityType: toSyncEntityType(sourceEntityType),
        },
      },
      data: {
        status: SyncStatus.IDLE,
        baselineCompletedAt: at,
        lastSuccessfulSyncAt: at,
        lastError: null,
      },
    });
  }

  async observe(
    observation: CommunicationObservation,
    allowEvent: boolean,
    detectedAt: Date,
  ): Promise<CommunicationObservationResult> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.inTransaction(
          async (transaction) => {
            const cursor = await transaction.communicationCursor.findUnique({
              where: {
                sourceEntityType_sourceRecordId: {
                  sourceEntityType: toPrismaSourceType(
                    observation.sourceEntityType,
                  ),
                  sourceRecordId: observation.sourceRecordId,
                },
              },
              select: { id: true, lastSignature: true, revision: true },
            });

            if (cursor?.lastSignature === observation.signature) {
              await transaction.communicationCursor.update({
                where: { id: cursor.id },
                data: { lastObservedAt: detectedAt },
              });
              return { outcome: "UNCHANGED", revision: cursor.revision };
            }

            const revision = cursor ? cursor.revision + 1 : 0;
            if (cursor) {
              await transaction.communicationCursor.update({
                where: { id: cursor.id },
                data: {
                  lastSignature: observation.signature,
                  revision,
                  lastObservedAt: detectedAt,
                },
              });
            } else {
              await transaction.communicationCursor.create({
                data: {
                  sourceEntityType: toPrismaSourceType(
                    observation.sourceEntityType,
                  ),
                  sourceRecordId: observation.sourceRecordId,
                  lastSignature: observation.signature,
                  revision,
                  firstObservedAt: detectedAt,
                  lastObservedAt: detectedAt,
                },
              });
            }

            if (!observation.scenario) {
              return { outcome: "NO_SCENARIO", revision };
            }
            if (!allowEvent) return { outcome: "SUPPRESSED", revision };

            const fingerprint = createCommunicationFingerprint(
              observation,
              revision,
            );
            await transaction.communicationEvent.create({
              data: {
                sourceEntityType: toPrismaSourceType(
                  observation.sourceEntityType,
                ),
                sourceRecordId: observation.sourceRecordId,
                scenario: observation.scenario as PrismaCommunicationScenario,
                fingerprint,
                eventSnapshot: {
                  ...observation.eventSnapshot,
                  communicationRevision: revision,
                } as Prisma.InputJsonObject,
                detectedAt,
              },
            });
            return { outcome: "CREATED", revision, fingerprint };
          },
        );
      } catch (error: unknown) {
        if (isRetryableTransactionError(error) && attempt < 3) continue;
        throw error;
      }
    }
    throw new Error("Communication event transaction retry limit reached");
  }

  private inTransaction<T>(operation: (transaction: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    if ("$transaction" in this.prisma) {
      return this.prisma.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    }
    return operation(this.prisma);
  }
}

export async function observeCommunication(input: {
  store: CommunicationEventStore;
  observation: CommunicationObservation;
  allowEvent: boolean;
  detectedAt: Date;
  log?: (message: string) => void;
}): Promise<CommunicationObservationResult> {
  const result = await input.store.observe(
    input.observation,
    input.allowEvent,
    input.detectedAt,
  );
  if (result.outcome === "CREATED") {
    input.log?.(
      `COMMUNICATION_EVENT_CREATED scenario=${input.observation.scenario} sourceEntityType=${input.observation.sourceEntityType} sourceRecordId=${input.observation.sourceRecordId}`,
    );
  } else if (
    input.observation.unknownPair &&
    result.outcome !== "UNCHANGED"
  ) {
    input.log?.(
      `COMMUNICATION_SCENARIO_UNKNOWN sourceEntityType=${input.observation.sourceEntityType} sourceRecordId=${input.observation.sourceRecordId}`,
    );
  }
  return result;
}

export function buildServiceOrderObservation(
  serviceOrder: MappedCase,
  detectedAt: Date,
): CommunicationObservation {
  const sourceEntityType = "SERVICE_ORDER" as const;
  const scenario = resolveCommunicationScenario({
    sourceEntityType,
    emmaCustomerStatus: serviceOrder.emmaCustomerStatus,
    emmaMailTemplate: serviceOrder.emmaMailTemplate,
  });
  const state = normalizeValue(serviceOrder.emmaCustomerStatus);
  const template = normalizeValue(serviceOrder.emmaMailTemplate);
  const fingerprintPayload = [scenario, state, template] as const;

  return {
    sourceEntityType,
    sourceRecordId: serviceOrder.airtableRecordId,
    scenario,
    signature: signature(fingerprintPayload),
    fingerprintPayload,
    unknownPair: Boolean(state && template && !scenario),
    eventSnapshot: {
      sourceEntityType,
      sourceRecordId: serviceOrder.airtableRecordId,
      scenario,
      emmaCustomerStatus: state,
      emmaMailTemplate: template,
      businessNumber: serviceOrder.businessNumber,
      clientOrderNumber: serviceOrder.clientOrderNumber,
      reportedAt: serviceOrder.reportedAt?.toISOString() ?? null,
      reportedAtRaw: snapshotString(serviceOrder.sourceSnapshot, "reportedAtRaw"),
      completedAt: snapshotString(serviceOrder.sourceSnapshot, "completedAt"),
      department: snapshotString(serviceOrder.sourceSnapshot, "department"),
      currentStatus: serviceOrder.currentStatus,
      serviceOrderType: serviceOrder.serviceOrderType,
      hospitalName: serviceOrder.hospitalName,
      sourceHospitalRecordId: serviceOrder.sourceHospitalRecordId,
      contactRecordIds: serviceOrder.contactRecordIds,
      device: {
        airtableRecordId: serviceOrder.deviceAirtableIds.length === 1
          ? serviceOrder.deviceAirtableIds[0]!
          : null,
        name: serviceOrder.deviceName,
        manufacturer: serviceOrder.manufacturer,
        model: serviceOrder.model,
        serialNumber: serviceOrder.serialNumber,
        inventoryNumber: serviceOrder.inventoryNumber,
      },
      detectedAt: detectedAt.toISOString(),
    },
  };
}

export function buildTaskObservation(
  task: MappedTask,
  detectedAt: Date,
): CommunicationObservation {
  const sourceEntityType = "TASK" as const;
  const scenario = resolveCommunicationScenario({
    sourceEntityType,
    emmaCustomerStatus: task.emmaCustomerStatus,
    emmaMailTemplate: task.emmaMailTemplate,
  });
  const state = normalizeValue(task.emmaCustomerStatus);
  const template = normalizeValue(task.emmaMailTemplate);
  const fingerprintPayload = taskFingerprintPayload(task, scenario, state, template);

  return {
    sourceEntityType,
    sourceRecordId: task.airtableRecordId,
    scenario,
    signature: signature(fingerprintPayload),
    fingerprintPayload,
    unknownPair: Boolean(state && template && !scenario),
    eventSnapshot: {
      sourceEntityType,
      sourceRecordId: task.airtableRecordId,
      taskNumber: task.taskNumber,
      scenario,
      emmaCustomerStatus: state,
      emmaMailTemplate: template,
      day: task.day,
      department: task.department,
      durationSeconds: task.durationSeconds,
      completed: task.completed,
      selectedContactRecordIds: task.selectedContactRecordIds,
      sourceHospitalRecordId: task.sourceHospitalRecordId,
      linkedInspectionRecordIds: task.linkedInspectionRecordIds,
      linkedServiceOrderRecordIds: task.linkedServiceOrderRecordIds,
      performerRecordIds: task.performerRecordIds,
      detectedAt: detectedAt.toISOString(),
    },
  };
}

export function createCommunicationFingerprint(
  observation: CommunicationObservation,
  revision: number,
): string {
  return signature([
    "emma-communication-event-v1",
    observation.sourceEntityType,
    observation.sourceRecordId,
    observation.scenario,
    revision,
    ...observation.fingerprintPayload,
  ]);
}

function taskFingerprintPayload(
  task: MappedTask,
  scenario: CommunicationScenario | null,
  state: string | null,
  template: string | null,
): readonly unknown[] {
  if (
    scenario === "INSPECTION_DATE_PROPOSED" ||
    scenario === "INSPECTION_DATE_CONFIRMED"
  ) {
    return [scenario, task.day, state, template];
  }
  if (scenario === "INSPECTION_REMINDER") {
    return [scenario, task.day, state, template];
  }
  if (scenario === "INSPECTION_COMPLETED") {
    return [scenario, task.completed, state, template];
  }
  return [null, task.day, task.completed, state, template];
}

function signature(payload: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function normalizeValue(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized || null;
}

function snapshotString(snapshot: Record<string, string | number | null>, key: string): string | null {
  const value = snapshot[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function toSyncEntityType(
  sourceEntityType: CommunicationSourceEntityType,
): SyncEntityType {
  return sourceEntityType === "TASK"
    ? SyncEntityType.TASK
    : SyncEntityType.SERVICE_ORDER;
}

function toPrismaSourceType(
  sourceEntityType: CommunicationSourceEntityType,
): PrismaCommunicationSourceEntityType {
  return sourceEntityType === "TASK"
    ? PrismaCommunicationSourceEntityType.TASK
    : PrismaCommunicationSourceEntityType.SERVICE_ORDER;
}

function isRetryableTransactionError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === "P2002" || error.code === "P2034");
}
