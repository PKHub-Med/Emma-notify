import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import {
  CaseType,
  CommunicationDiagnosticOrigin,
  CommunicationDiagnosticStatus,
  CommunicationDeliveryStatus,
  CommunicationScenario,
  CommunicationSourceEntityType,
} from "../generated/prisma/enums.js";
import type { CommunicationObservation } from "./communication-event.js";

const HISTORY_RETENTION_MS = 180 * 24 * 60 * 60_000;
const PENDING_RETRY_MS = 2 * 60_000;
const PENDING_OBSERVATION_MS = 60 * 60_000;
const PENDING_LIMIT = 250;
const STICKY_HISTORICAL_BLOCK_REASONS = new Set([
  "READY_BUT_HISTORICAL",
  "PENDING_DATA_EXPIRED",
]);

export type CompletedDataReadiness =
  | { ready: true }
  | {
      ready: false;
      reasonCode: string;
      missingData: Record<string, unknown>;
    };

export type DiagnosticTransition = {
  sourceEntityType: CommunicationSourceEntityType;
  sourceRecordId: string;
  businessNumber?: string | null;
  scenario?: CommunicationScenario | null;
  status: CommunicationDiagnosticStatus;
  reasonCode: string;
  reasonOrigin: CommunicationDiagnosticOrigin;
  missingData?: Record<string, unknown> | null;
  checkedAt: Date;
  nextCheckAt?: Date | null;
  expiresAt?: Date | null;
  eventId?: string | null;
  deliveryId?: string | null;
};

export type PendingTaskDiagnostic = {
  sourceRecordId: string;
  firstDetectedAt: Date;
  expiresAt: Date | null;
  reasonCode: string;
  missingData: Record<string, unknown> | null;
};

export interface CommunicationDiagnosticRegistry {
  record(input: DiagnosticTransition): Promise<boolean>;
  assessCompletedData(observation: CommunicationObservation): Promise<CompletedDataReadiness>;
  findDuePendingTasks(now: Date, limit?: number): Promise<PendingTaskDiagnostic[]>;
  wakePendingForInspection(inspectionRecordId: string, at: Date): Promise<number>;
  synchronizeDelivery(deliveryId: string, at: Date): Promise<void>;
  summarizeCycle(since: Date): Promise<CommunicationCycleSummary>;
  pruneExpired?(now: Date): Promise<{ current: number; history: number }>;
}

export type CommunicationCycleSummary = {
  checked: number;
  pending: number;
  blocked: number;
  eventsCreated: number;
  sent: number;
  cancelled: number;
  interventionRequired: number;
};

export class PrismaCommunicationDiagnosticRegistry implements CommunicationDiagnosticRegistry {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly log: (message: string) => void = console.info,
  ) {}

  async record(input: DiagnosticTransition): Promise<boolean> {
    const scenarioKey = input.scenario ?? "NONE";
    const diagnosticKey = diagnosticFingerprint(
      input.sourceEntityType,
      input.sourceRecordId,
      scenarioKey,
    );
    const retentionUntil = new Date(input.checkedAt.getTime() + HISTORY_RETENTION_MS);
    const terminalAt = terminalStatuses.has(input.status) ? input.checkedAt : null;
    const missingData = input.missingData
      ? input.missingData as Prisma.InputJsonObject
      : Prisma.JsonNull;

    const changed = await this.prisma.$transaction(async (transaction) => {
      const existing = await transaction.communicationDiagnostic.findUnique({
        where: { diagnosticKey },
      });
      // These outcomes are deliberately irreversible. A later Airtable overlap,
      // process restart, or repeated poll must not turn yesterday's task back
      // into eligible work. Keep the original reason and evidence, while still
      // recording that the diagnostic was checked again.
      if (existing?.status === CommunicationDiagnosticStatus.BLOCKED &&
          STICKY_HISTORICAL_BLOCK_REASONS.has(existing.reasonCode)) {
        await transaction.communicationDiagnostic.update({
          where: { id: existing.id },
          data: {
            lastCheckedAt: input.checkedAt,
            retentionUntil,
          },
        });
        return false;
      }
      const transitionChanged = !existing || existing.status !== input.status ||
        existing.reasonCode !== input.reasonCode ||
        existing.reasonOrigin !== input.reasonOrigin ||
        !isDeepStrictEqual(jsonObject(existing.missingData), input.missingData ?? null);
      const attemptCount = input.status === CommunicationDiagnosticStatus.PENDING_DATA
        ? (existing?.attemptCount ?? 0) + 1
        : existing?.attemptCount ?? 0;
      const current = await transaction.communicationDiagnostic.upsert({
        where: { diagnosticKey },
        create: {
          diagnosticKey,
          sourceEntityType: input.sourceEntityType,
          sourceRecordId: input.sourceRecordId,
          businessNumber: input.businessNumber ?? null,
          scenario: input.scenario ?? null,
          scenarioKey,
          status: input.status,
          reasonCode: input.reasonCode,
          reasonOrigin: input.reasonOrigin,
          missingData,
          firstDetectedAt: input.checkedAt,
          lastCheckedAt: input.checkedAt,
          attemptCount,
          nextCheckAt: input.nextCheckAt ?? null,
          expiresAt: input.expiresAt ?? null,
          terminalAt,
          communicationEventId: input.eventId ?? null,
          communicationDeliveryId: input.deliveryId ?? null,
          retentionUntil,
        },
        update: {
          businessNumber: input.businessNumber ?? existing?.businessNumber ?? null,
          status: input.status,
          reasonCode: input.reasonCode,
          reasonOrigin: input.reasonOrigin,
          missingData,
          lastCheckedAt: input.checkedAt,
          attemptCount,
          nextCheckAt: input.nextCheckAt ?? null,
          // A pending deadline is anchored at first detection and must never
          // slide forward on subsequent polling attempts.
          expiresAt: existing?.expiresAt ?? input.expiresAt ?? null,
          terminalAt,
          communicationEventId: input.eventId ?? existing?.communicationEventId ?? null,
          communicationDeliveryId: input.deliveryId ?? existing?.communicationDeliveryId ?? null,
          retentionUntil,
        },
      });
      if (transitionChanged) {
        await transaction.communicationDiagnosticHistory.create({
          data: {
            diagnosticId: current.id,
            status: input.status,
            reasonCode: input.reasonCode,
            reasonOrigin: input.reasonOrigin,
            details: missingData,
            occurredAt: input.checkedAt,
            retentionUntil,
          },
        });
      }
      return transitionChanged;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    if (changed) this.log(formatDiagnosticLog(input));
    return changed;
  }

  async assessCompletedData(observation: CommunicationObservation): Promise<CompletedDataReadiness> {
    const snapshot = object(observation.eventSnapshot);
    const inspectionIds = stringArray(snapshot.linkedInspectionRecordIds);
    if (inspectionIds.length === 0) {
      return pending("INSPECTION_LINKS_MISSING", { expectedInspectionIds: [] });
    }
    const hospitalId = nonEmptyString(snapshot.sourceHospitalRecordId);
    if (!hospitalId) {
      return pending("HOSPITAL_SCOPE_MISSING", { expectedInspectionIds: inspectionIds });
    }
    const inspections = await this.prisma.trackedCase.findMany({
      where: {
        caseType: CaseType.INSPECTION,
        active: true,
        airtableRecordId: { in: inspectionIds },
      },
      select: {
        airtableRecordId: true,
        sourceHospitalRecordId: true,
        inspectionResult: true,
      },
    });
    const found = new Set(inspections.map((inspection) => inspection.airtableRecordId));
    const missingIds = inspectionIds.filter((id) => !found.has(id));
    if (missingIds.length > 0 || inspections.length !== inspectionIds.length) {
      return pending("INSPECTIONS_NOT_SYNCED", {
        expectedCount: inspectionIds.length,
        foundCount: inspections.length,
        missingInspectionIds: missingIds,
        expectedInspectionIds: inspectionIds,
      });
    }
    const missingScope = inspections
      .filter((inspection) => !inspection.sourceHospitalRecordId)
      .map((inspection) => inspection.airtableRecordId);
    if (missingScope.length > 0) {
      return pending("INSPECTION_SCOPE_INCOMPLETE", {
        missingScopeInspectionIds: missingScope,
        expectedInspectionIds: inspectionIds,
      });
    }
    const conflictingScope = inspections
      .filter((inspection) => inspection.sourceHospitalRecordId !== hospitalId)
      .map((inspection) => inspection.airtableRecordId);
    if (conflictingScope.length > 0) {
      return pending("INSPECTION_SCOPE_MISMATCH", {
        conflictingInspectionIds: conflictingScope,
        expectedInspectionIds: inspectionIds,
      });
    }
    const missingResults = inspections
      .filter((inspection) => !recognizedInspectionResult(inspection.inspectionResult))
      .map((inspection) => inspection.airtableRecordId);
    if (missingResults.length > 0) {
      return pending("INSPECTION_RESULTS_INCOMPLETE", {
        missingResultInspectionIds: missingResults,
        expectedInspectionIds: inspectionIds,
      });
    }
    return { ready: true };
  }

  async findDuePendingTasks(now: Date, limit = PENDING_LIMIT): Promise<PendingTaskDiagnostic[]> {
    const rows = await this.prisma.communicationDiagnostic.findMany({
      where: {
        sourceEntityType: CommunicationSourceEntityType.TASK,
        scenario: CommunicationScenario.INSPECTION_COMPLETED,
        status: CommunicationDiagnosticStatus.PENDING_DATA,
        OR: [{ nextCheckAt: null }, { nextCheckAt: { lte: now } }],
      },
      orderBy: { lastCheckedAt: "asc" },
      take: limit,
      select: {
        sourceRecordId: true,
        firstDetectedAt: true,
        expiresAt: true,
        reasonCode: true,
        missingData: true,
      },
    });
    return rows.map((row) => ({
      sourceRecordId: row.sourceRecordId,
      firstDetectedAt: row.firstDetectedAt,
      expiresAt: row.expiresAt,
      reasonCode: row.reasonCode,
      missingData: jsonObject(row.missingData),
    }));
  }

  async wakePendingForInspection(inspectionRecordId: string, at: Date): Promise<number> {
    const rows = await this.prisma.communicationDiagnostic.findMany({
      where: {
        sourceEntityType: CommunicationSourceEntityType.TASK,
        scenario: CommunicationScenario.INSPECTION_COMPLETED,
        status: CommunicationDiagnosticStatus.PENDING_DATA,
      },
      take: 1000,
      select: { id: true, missingData: true },
    });
    const ids = rows.filter((row) =>
      diagnosticInspectionIds(row.missingData).includes(inspectionRecordId)).map((row) => row.id);
    if (ids.length === 0) return 0;
    const result = await this.prisma.communicationDiagnostic.updateMany({
      where: { id: { in: ids }, status: CommunicationDiagnosticStatus.PENDING_DATA },
      data: { nextCheckAt: at },
    });
    return result.count;
  }

  async synchronizeDelivery(deliveryId: string, at: Date): Promise<void> {
    const delivery = await this.prisma.communicationDelivery.findUnique({
      where: { id: deliveryId },
      select: {
        id: true,
        status: true,
        cancelReason: true,
        lastError: true,
        nextRetryAt: true,
        communicationEvent: {
          select: { id: true, sourceEntityType: true, sourceRecordId: true, scenario: true, eventSnapshot: true },
        },
      },
    });
    if (!delivery) return;
    const mapped = diagnosticStatusForDelivery(delivery.status, delivery.nextRetryAt);
    const snapshot = object(delivery.communicationEvent.eventSnapshot);
    await this.record({
      sourceEntityType: delivery.communicationEvent.sourceEntityType,
      sourceRecordId: delivery.communicationEvent.sourceRecordId,
      businessNumber: nonEmptyString(snapshot.taskNumber) ?? nonEmptyString(snapshot.businessNumber),
      scenario: delivery.communicationEvent.scenario,
      status: mapped,
      // Provider errors can contain an address or request payload. Keep only a
      // stable classification in the central registry and Railway logs.
      reasonCode: delivery.cancelReason ?? deliveryReasonCode(
        delivery.status,
        delivery.nextRetryAt,
        delivery.lastError !== null,
      ),
      reasonOrigin: delivery.status === CommunicationDeliveryStatus.FAILED ||
          delivery.status === CommunicationDeliveryStatus.SENT
        ? CommunicationDiagnosticOrigin.PROVIDER
        : CommunicationDiagnosticOrigin.APPLICATION,
      checkedAt: at,
      nextCheckAt: delivery.nextRetryAt,
      eventId: delivery.communicationEvent.id,
      deliveryId: delivery.id,
    });
  }

  async summarizeCycle(since: Date): Promise<CommunicationCycleSummary> {
    const rows = await this.prisma.communicationDiagnostic.findMany({
      where: { lastCheckedAt: { gte: since } },
      select: { status: true, communicationEventId: true },
    });
    const count = (status: CommunicationDiagnosticStatus) =>
      rows.filter((row) => row.status === status).length;
    return {
      checked: rows.length,
      pending: count(CommunicationDiagnosticStatus.PENDING_DATA),
      blocked: count(CommunicationDiagnosticStatus.BLOCKED),
      eventsCreated: rows.filter((row) => row.communicationEventId !== null).length,
      sent: count(CommunicationDiagnosticStatus.SENT),
      cancelled: count(CommunicationDiagnosticStatus.CANCELLED),
      interventionRequired: rows.filter((row) =>
        row.status === CommunicationDiagnosticStatus.BLOCKED ||
        row.status === CommunicationDiagnosticStatus.FAILED).length,
    };
  }

  async pruneExpired(now: Date): Promise<{ current: number; history: number }> {
    return this.prisma.$transaction(async (transaction) => {
      const history = await transaction.communicationDiagnosticHistory.deleteMany({
        where: { retentionUntil: { lt: now } },
      });
      const current = await transaction.communicationDiagnostic.deleteMany({
        where: {
          retentionUntil: { lt: now },
          status: { in: [...terminalStatuses] },
        },
      });
      return { current: current.count, history: history.count };
    });
  }
}

export function nextPendingCheck(now: Date): Date {
  return new Date(now.getTime() + PENDING_RETRY_MS);
}

export function pendingDataExpiresAt(firstDetectedAt: Date): Date {
  return new Date(firstDetectedAt.getTime() + PENDING_OBSERVATION_MS);
}

function pending(reasonCode: string, missingData: Record<string, unknown>): CompletedDataReadiness {
  return { ready: false, reasonCode, missingData };
}

function recognizedInspectionResult(value: string | null): boolean {
  const status = value?.trim().toUpperCase() ?? "";
  return status.includes("NIESPRAW") || status.includes("WARUNK") ||
    status === "SPRAWNY" || status.startsWith("SPRAWNY ");
}

function diagnosticFingerprint(
  sourceEntityType: CommunicationSourceEntityType,
  sourceRecordId: string,
  scenarioKey: string,
): string {
  return createHash("sha256")
    .update([sourceEntityType, sourceRecordId, scenarioKey].join("|"))
    .digest("hex");
}

function formatDiagnosticLog(input: DiagnosticTransition): string {
  const event = input.status === CommunicationDiagnosticStatus.PENDING_DATA
    ? "COMMUNICATION_PENDING"
    : input.status === CommunicationDiagnosticStatus.BLOCKED
      ? "COMMUNICATION_BLOCKED"
      : input.status === CommunicationDiagnosticStatus.SENT
        ? "COMMUNICATION_SENT"
        : input.status === CommunicationDiagnosticStatus.FAILED
          ? "COMMUNICATION_FAILED"
          : input.status === CommunicationDiagnosticStatus.NOT_ELIGIBLE
            ? "COMMUNICATION_NOT_ELIGIBLE"
            : input.status === CommunicationDiagnosticStatus.READY
              ? "COMMUNICATION_RECOVERED"
              : input.status === CommunicationDiagnosticStatus.CANCELLED
                ? "COMMUNICATION_CANCELLED"
                : "COMMUNICATION_SCHEDULED";
  return `${event} sourceEntityType=${input.sourceEntityType} ` +
    `sourceRecordId=${input.sourceRecordId} scenario=${input.scenario ?? "NONE"} ` +
    `status=${input.status} reason=${input.reasonCode} origin=${input.reasonOrigin} ` +
    `nextCheckAt=${input.nextCheckAt?.toISOString() ?? "none"}`;
}

function diagnosticStatusForDelivery(
  status: CommunicationDeliveryStatus,
  nextRetryAt: Date | null,
): CommunicationDiagnosticStatus {
  if (status === CommunicationDeliveryStatus.SENT) return CommunicationDiagnosticStatus.SENT;
  if (status === CommunicationDeliveryStatus.CANCELLED) return CommunicationDiagnosticStatus.CANCELLED;
  if (status === CommunicationDeliveryStatus.FAILED) {
    return nextRetryAt ? CommunicationDiagnosticStatus.SCHEDULED : CommunicationDiagnosticStatus.FAILED;
  }
  if (status === CommunicationDeliveryStatus.SCHEDULED) return CommunicationDiagnosticStatus.SCHEDULED;
  return CommunicationDiagnosticStatus.READY;
}

function deliveryReasonCode(
  status: CommunicationDeliveryStatus,
  nextRetryAt: Date | null,
  hasError: boolean,
): string {
  if (status === CommunicationDeliveryStatus.SENT) return "PROVIDER_ACCEPTED";
  if (status === CommunicationDeliveryStatus.FAILED) {
    return nextRetryAt ? "PROVIDER_RETRY_SCHEDULED" : "PROVIDER_FAILED";
  }
  if (status === CommunicationDeliveryStatus.SCHEDULED) return "DELIVERY_SCHEDULED";
  if (hasError) return "DELIVERY_ERROR_REDACTED";
  return status;
}

function diagnosticInspectionIds(value: unknown): string[] {
  const details = jsonObject(value);
  if (!details) return [];
  return [
    ...stringArray(details.expectedInspectionIds),
    ...stringArray(details.missingInspectionIds),
    ...stringArray(details.missingResultInspectionIds),
    ...stringArray(details.missingScopeInspectionIds),
    ...stringArray(details.conflictingInspectionIds),
  ];
}

const terminalStatuses = new Set<CommunicationDiagnosticStatus>([
  CommunicationDiagnosticStatus.NOT_ELIGIBLE,
  CommunicationDiagnosticStatus.BLOCKED,
  CommunicationDiagnosticStatus.SENT,
  CommunicationDiagnosticStatus.FAILED,
  CommunicationDiagnosticStatus.CANCELLED,
]);

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  const result = object(value);
  return Object.keys(result).length > 0 ? result : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string =>
        typeof item === "string" && item.trim().length > 0).map((item) => item.trim()))]
    : [];
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
