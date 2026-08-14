import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import {
  CommunicationDeliveryCancelReason,
  CommunicationDeliveryStatus,
  CommunicationRecipientType,
  CommunicationScenario,
} from "../generated/prisma/enums.js";
import type {
  EmailProvider,
  ProviderEmailResult,
  TemplateVariableValue,
} from "../email/resend-client.js";
import {
  assertTestRecipient,
  RecipientSafetyError,
  resolveActualRecipient,
  type EmailMode,
} from "../email/recipient.js";
import type { PortalAccessGrantRecord } from "../portal-access/service.js";
import type { UnsubscribeGrantRecord } from "../communication-unsubscribe/service.js";
import {
  buildCommunicationTemplatePayload,
  CommunicationTemplateDataError,
  type CommunicationTemplateDataSource,
} from "./communication-template-data.js";
import {
  reminderCancellationReason,
  type CurrentTaskState,
} from "./communication-delivery.js";
import type { CommunicationAssetPreflight } from "../assets/preflight.js";
import { normalizeCommunicationTemplateVariables } from "./communication-template-registry.js";

const MAX_ATTEMPTS = 4;
const STALE_SENDING_MS = 5 * 60_000;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 15 * 60_000] as const;
const CANDIDATE_LIMIT = 10;

export type PersistedCommunicationSendSnapshot = {
  templateId: string;
  variables: Record<string, TemplateVariableValue>;
  portalGrantPublicId: string;
  unsubscribeGrantPublicId: string;
  preparedAt: string;
};

export type CommunicationSendCandidate = {
  id: string;
  status: CommunicationDeliveryStatus;
  scenario: CommunicationScenario;
  scheduledFor: Date;
  attemptCount: number;
  sendingStartedAt: Date | null;
  nextRetryAt: Date | null;
  sendSnapshot: PersistedCommunicationSendSnapshot | null;
  event: {
    detectedAt: Date;
    sourceRecordId: string;
    eventSnapshot: unknown;
  };
  recipient: {
    recipientType: CommunicationRecipientType;
    email: string | null;
    normalizedEmail: string | null;
  };
};

export interface CommunicationEmailSendStore {
  findCandidates(now: Date, limit: number): Promise<CommunicationSendCandidate[]>;
  claim(
    candidate: CommunicationSendCandidate,
    now: Date,
    mode: EmailMode,
    actualRecipientEmail: string,
  ): Promise<boolean>;
  getCurrentTask(sourceRecordId: string): Promise<CurrentTaskState | null>;
  saveSnapshot(
    deliveryId: string,
    snapshot: PersistedCommunicationSendSnapshot,
    preparedAt: Date,
  ): Promise<PersistedCommunicationSendSnapshot>;
  markSent(deliveryId: string, messageId: string, sentAt: Date): Promise<void>;
  markFailed(
    deliveryId: string,
    reason: string,
    failedAt: Date,
    nextRetryAt: Date | null,
  ): Promise<void>;
  cancel(
    deliveryId: string,
    reason: CommunicationDeliveryCancelReason,
    cancelledAt: Date,
  ): Promise<boolean>;
}

export interface CommunicationPortalGrantProvider {
  getOrCreatePortalAccessGrant(
    deliveryId: string,
    now?: Date,
  ): Promise<{ grant: PortalAccessGrantRecord; url: string }>;
}

export interface CommunicationUnsubscribeGrantProvider {
  getOrCreateUnsubscribeGrant(
    deliveryId: string,
    now?: Date,
  ): Promise<{ grant: UnsubscribeGrantRecord; url: string }>;
}

export type CommunicationEmailSenderConfig = {
  communicationEmailsEnabled: boolean;
  communicationSendNotBefore: Date | null;
  mode: EmailMode;
  testEmail: string | null;
  productionEmailsEnabled: boolean;
  resendApiKey: string | null;
  replyTo: string;
  timeZone: string;
  communicationAssetsEnabled?: boolean;
};

export class PrismaCommunicationEmailSendStore implements CommunicationEmailSendStore {
  constructor(private readonly prisma: PrismaClient) {}

  async findCandidates(now: Date, limit: number): Promise<CommunicationSendCandidate[]> {
    const staleBefore = new Date(now.getTime() - STALE_SENDING_MS);
    const deliveries = await this.prisma.communicationDelivery.findMany({
      where: {
        attemptCount: { lt: MAX_ATTEMPTS },
        OR: [
          { status: CommunicationDeliveryStatus.READY },
          {
            status: CommunicationDeliveryStatus.FAILED,
            nextRetryAt: { not: null, lte: now },
          },
          {
            status: CommunicationDeliveryStatus.SENDING,
            sendingStartedAt: { not: null, lte: staleBefore },
          },
        ],
      },
      orderBy: { scheduledFor: "asc" },
      take: limit,
      select: {
        id: true,
        status: true,
        scenario: true,
        scheduledFor: true,
        attemptCount: true,
        sendingStartedAt: true,
        nextRetryAt: true,
        sendSnapshot: true,
        communicationEvent: {
          select: {
            detectedAt: true,
            sourceRecordId: true,
            eventSnapshot: true,
          },
        },
        communicationEventRecipient: {
          select: { recipientType: true, email: true, normalizedEmail: true },
        },
      },
    });
    return deliveries.map((delivery) => ({
      id: delivery.id,
      status: delivery.status,
      scenario: delivery.scenario,
      scheduledFor: delivery.scheduledFor,
      attemptCount: delivery.attemptCount,
      sendingStartedAt: delivery.sendingStartedAt,
      nextRetryAt: delivery.nextRetryAt,
      sendSnapshot: parseSendSnapshot(delivery.sendSnapshot),
      event: delivery.communicationEvent,
      recipient: delivery.communicationEventRecipient,
    }));
  }

  async claim(
    candidate: CommunicationSendCandidate,
    now: Date,
    mode: EmailMode,
    actualRecipientEmail: string,
  ): Promise<boolean> {
    const staleBefore = new Date(now.getTime() - STALE_SENDING_MS);
    const state: Prisma.CommunicationDeliveryWhereInput =
      candidate.status === CommunicationDeliveryStatus.READY
        ? { status: CommunicationDeliveryStatus.READY }
        : candidate.status === CommunicationDeliveryStatus.FAILED
          ? {
              status: CommunicationDeliveryStatus.FAILED,
              nextRetryAt: { not: null, lte: now },
            }
          : {
              status: CommunicationDeliveryStatus.SENDING,
              sendingStartedAt: { not: null, lte: staleBefore },
            };
    const claimed = await this.prisma.communicationDelivery.updateMany({
      where: {
        id: candidate.id,
        attemptCount: candidate.attemptCount,
        ...state,
      },
      data: {
        status: CommunicationDeliveryStatus.SENDING,
        sendingStartedAt: now,
        failedAt: null,
        nextRetryAt: null,
        lastError: null,
        emailMode: mode,
        actualRecipientEmail,
        attemptCount: { increment: 1 },
      },
    });
    return claimed.count === 1;
  }

  getCurrentTask(sourceRecordId: string): Promise<CurrentTaskState | null> {
    return this.prisma.trackedTask.findUnique({
      where: { airtableRecordId: sourceRecordId },
      select: {
        day: true,
        emmaCustomerStatus: true,
        emmaMailTemplate: true,
        completed: true,
      },
    });
  }

  async saveSnapshot(
    deliveryId: string,
    snapshot: PersistedCommunicationSendSnapshot,
    preparedAt: Date,
  ): Promise<PersistedCommunicationSendSnapshot> {
    await this.prisma.communicationDelivery.updateMany({
      where: {
        id: deliveryId,
        status: CommunicationDeliveryStatus.SENDING,
        sendSnapshot: { equals: Prisma.DbNull },
      },
      data: {
        preparedAt,
        sendSnapshot: snapshot as unknown as Prisma.InputJsonObject,
      },
    });
    const stored = await this.prisma.communicationDelivery.findUniqueOrThrow({
      where: { id: deliveryId },
      select: { sendSnapshot: true },
    });
    const parsed = parseSendSnapshot(stored.sendSnapshot);
    if (!parsed) throw new Error("SEND_SNAPSHOT_INVALID");
    return parsed;
  }

  async markSent(deliveryId: string, messageId: string, sentAt: Date): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.communicationDelivery.updateMany({
        where: { id: deliveryId, status: CommunicationDeliveryStatus.SENDING },
        data: {
          status: CommunicationDeliveryStatus.SENT,
          sentAt,
          resendMessageId: messageId,
          failedAt: null,
          nextRetryAt: null,
          lastError: null,
        },
      }),
      this.prisma.communicationAsset.updateMany({
        where: { deliveryId, exposedAt: null }, data: { exposedAt: sentAt },
      }),
    ]);
  }

  async markFailed(
    deliveryId: string,
    reason: string,
    failedAt: Date,
    nextRetryAt: Date | null,
  ): Promise<void> {
    const result = await this.prisma.communicationDelivery.updateMany({
      where: { id: deliveryId, status: CommunicationDeliveryStatus.SENDING },
      data: {
        status: CommunicationDeliveryStatus.FAILED,
        failedAt,
        nextRetryAt,
        lastError: reason,
      },
    });
    if (result.count === 1 && nextRetryAt === null) {
      await this.markOrphanCandidates(deliveryId, failedAt);
    }
  }

  async cancel(
    deliveryId: string,
    reason: CommunicationDeliveryCancelReason,
    cancelledAt: Date,
  ): Promise<boolean> {
    const result = await this.prisma.communicationDelivery.updateMany({
      where: {
        id: deliveryId,
        status: {
          in: [
            CommunicationDeliveryStatus.READY,
            CommunicationDeliveryStatus.FAILED,
            CommunicationDeliveryStatus.SENDING,
          ],
        },
      },
      data: {
        status: CommunicationDeliveryStatus.CANCELLED,
        cancelReason: reason,
        failedAt: null,
        nextRetryAt: null,
        lastError: null,
        sendingStartedAt: cancelledAt,
      },
    });
    if (result.count === 1) await this.markOrphanCandidates(deliveryId, cancelledAt);
    return result.count === 1;
  }

  private async markOrphanCandidates(deliveryId: string, at: Date): Promise<void> {
    await this.prisma.storedFile.updateMany({
      where: {
        orphanedAt: null,
        communicationAssets: {
          some: { deliveryId },
          none: {
            OR: [
              { exposedAt: { not: null } },
              { delivery: { status: { in: [
                CommunicationDeliveryStatus.SCHEDULED,
                CommunicationDeliveryStatus.READY,
                CommunicationDeliveryStatus.SENDING,
                CommunicationDeliveryStatus.SENT,
              ] } } },
              { delivery: {
                status: CommunicationDeliveryStatus.FAILED,
                nextRetryAt: { not: null },
              } },
            ],
          },
        },
      },
      data: { orphanedAt: at },
    });
  }
}

export async function runCommunicationEmailSender(input: {
  store: CommunicationEmailSendStore;
  provider: EmailProvider;
  grants: CommunicationPortalGrantProvider;
  unsubscribeGrants: CommunicationUnsubscribeGrantProvider;
  dataSource: CommunicationTemplateDataSource;
  assetPreflight?: CommunicationAssetPreflight;
  config: CommunicationEmailSenderConfig;
  now?: () => Date;
  log?: (message: string) => void;
}): Promise<{ candidates: number; sent: number; failed: number; cancelled: number }> {
  const stats = { candidates: 0, sent: 0, failed: 0, cancelled: 0 };
  if (!input.config.communicationEmailsEnabled) return stats;
  if (!input.config.communicationSendNotBefore) {
    input.log?.("COMMUNICATION_EMAIL_BARRIER_BLOCKED reason=SEND_NOT_BEFORE_INVALID");
    return stats;
  }
  if (input.config.mode === "PRODUCTION" && !input.config.productionEmailsEnabled) {
    input.log?.("COMMUNICATION_EMAIL_BARRIER_BLOCKED reason=PRODUCTION_EMAILS_BLOCKED");
    return stats;
  }
  const now = input.now ?? (() => new Date());
  const candidates = await input.store.findCandidates(now(), CANDIDATE_LIMIT);
  stats.candidates = candidates.length;
  for (const candidate of candidates) {
    const outcome = await sendCommunicationDelivery({ ...input, candidate, now: now() });
    if (outcome === "SENT") stats.sent += 1;
    if (outcome === "FAILED") stats.failed += 1;
    if (outcome === "CANCELLED") stats.cancelled += 1;
  }
  return stats;
}

export async function sendCommunicationDelivery(input: {
  store: CommunicationEmailSendStore;
  provider: EmailProvider;
  grants: CommunicationPortalGrantProvider;
  unsubscribeGrants: CommunicationUnsubscribeGrantProvider;
  dataSource: CommunicationTemplateDataSource;
  assetPreflight?: CommunicationAssetPreflight;
  config: CommunicationEmailSenderConfig;
  candidate: CommunicationSendCandidate;
  now: Date;
  log?: (message: string) => void;
}): Promise<"SENT" | "FAILED" | "CANCELLED" | "SKIPPED"> {
  const activation = input.config.communicationSendNotBefore;
  if (!input.config.communicationEmailsEnabled || !activation) return "SKIPPED";
  if (!snapshotString(input.candidate.event.eventSnapshot, "sourceHospitalRecordId")) {
    const reason = isPreActivation(input.candidate, activation)
      ? CommunicationDeliveryCancelReason.MISSING_HOSPITAL_SCOPE_LEGACY
      : CommunicationDeliveryCancelReason.MISSING_HOSPITAL_SCOPE;
    await input.store.cancel(input.candidate.id, reason, input.now);
    input.log?.(
      `COMMUNICATION_DELIVERY_CANCELLED deliveryId=${input.candidate.id} reason=${reason}`,
    );
    return "CANCELLED";
  }
  if (isPreActivation(input.candidate, activation)) {
    await input.store.cancel(
      input.candidate.id,
      CommunicationDeliveryCancelReason.PRE_ACTIVATION,
      input.now,
    );
    input.log?.(
      `COMMUNICATION_EMAIL_CANCELLED deliveryId=${input.candidate.id} reason=PRE_ACTIVATION`,
    );
    return "CANCELLED";
  }

  let actualRecipientEmail: string;
  try {
    actualRecipientEmail = resolveActualRecipient({
      mode: input.config.mode,
      intendedRecipientEmail: input.candidate.recipient.email ?? "",
      testEmail: input.config.testEmail,
      productionEmailsEnabled: input.config.productionEmailsEnabled,
    });
    assertTestRecipient({
      mode: input.config.mode,
      actualRecipientEmail,
      testEmail: input.config.testEmail,
    });
  } catch (error: unknown) {
    return failUnclaimed(input, recipientErrorCode(error));
  }
  const attempt = input.candidate.attemptCount + 1;
  const claimed = await input.store.claim(
    input.candidate,
    input.now,
    input.config.mode,
    actualRecipientEmail,
  );
  if (!claimed) return "SKIPPED";
  input.log?.(
    `COMMUNICATION_EMAIL_CLAIMED deliveryId=${input.candidate.id} scenario=${input.candidate.scenario}`,
  );

  if (input.candidate.scenario === CommunicationScenario.INSPECTION_REMINDER &&
      !input.candidate.sendSnapshot) {
    let currentTask: CurrentTaskState | null;
    try {
      currentTask = await input.store.getCurrentTask(
        input.candidate.event.sourceRecordId,
      );
    } catch {
      return fail(input, "REMINDER_VALIDATION_ERROR", true, attempt);
    }
    const cancelReason = reminderCancellationReason(
      input.candidate.event.eventSnapshot,
      currentTask,
      input.now,
      input.config.timeZone,
    );
    if (cancelReason) {
      await input.store.cancel(input.candidate.id, cancelReason, input.now);
      input.log?.(
        `COMMUNICATION_EMAIL_CANCELLED deliveryId=${input.candidate.id} reason=${cancelReason}`,
      );
      return "CANCELLED";
    }
  }

  if (input.config.communicationAssetsEnabled && input.assetPreflight) {
    await input.assetPreflight.prepare({
      id: input.candidate.id,
      scenario: input.candidate.scenario,
      sourceRecordId: input.candidate.event.sourceRecordId,
      eventSnapshot: input.candidate.event.eventSnapshot,
    });
  }

  if (!input.config.resendApiKey) return fail(input, "RESEND_API_KEY_MISSING", false, attempt);

  let grantResult: Awaited<ReturnType<CommunicationPortalGrantProvider["getOrCreatePortalAccessGrant"]>>;
  try {
    grantResult = await input.grants.getOrCreatePortalAccessGrant(
      input.candidate.id,
      input.now,
    );
  } catch (error: unknown) {
    const failure = portalGrantFailure(error);
    return fail(input, failure.code, failure.retryable, attempt);
  }

  let unsubscribeResult: Awaited<ReturnType<CommunicationUnsubscribeGrantProvider["getOrCreateUnsubscribeGrant"]>>;
  try {
    unsubscribeResult = await input.unsubscribeGrants.getOrCreateUnsubscribeGrant(
      input.candidate.id,
      input.now,
    );
  } catch (error: unknown) {
    const failure = portalGrantFailure(error);
    return fail(input, failure.code, failure.retryable, attempt);
  }

  let snapshot = input.candidate.sendSnapshot;
  if (!snapshot) {
    try {
      const payload = await buildCommunicationTemplatePayload({
        delivery: {
          id: input.candidate.id,
          scenario: input.candidate.scenario,
          sourceRecordId: input.candidate.event.sourceRecordId,
          eventSnapshot: input.candidate.event.eventSnapshot,
        },
        dataSource: input.dataSource,
        secureUrl: grantResult.url,
        unsubscribeUrl: unsubscribeResult.url,
        preparedAt: input.now,
        timeZone: input.config.timeZone,
      });
      const { EMMA_SECURE_URL: _secureUrl, EMMA_UNSUBSCRIBE_URL: _unsubscribeUrl, ...safeVariables } = payload.variables;
      snapshot = await input.store.saveSnapshot(input.candidate.id, {
        templateId: payload.templateId,
        variables: safeVariables,
        portalGrantPublicId: grantResult.grant.publicId,
        unsubscribeGrantPublicId: unsubscribeResult.grant.publicId,
        preparedAt: input.now.toISOString(),
      }, input.now);
    } catch (error: unknown) {
      const failure = templateFailure(error);
      return fail(input, failure.code, failure.retryable, attempt);
    }
  }
  if (snapshot.portalGrantPublicId !== grantResult.grant.publicId) {
    return fail(input, "SEND_SNAPSHOT_GRANT_MISMATCH", false, attempt);
  }
  if (snapshot.unsubscribeGrantPublicId !== unsubscribeResult.grant.publicId) {
    return fail(input, "SEND_SNAPSHOT_UNSUBSCRIBE_GRANT_MISMATCH", false, attempt);
  }

  let variables: Record<string, TemplateVariableValue>;
  try {
    variables = normalizeCommunicationTemplateVariables(snapshot.templateId, {
      ...snapshot.variables,
      EMMA_SECURE_URL: grantResult.url,
      EMMA_UNSUBSCRIBE_URL: unsubscribeResult.url,
    });
  } catch {
    return fail(input, "TEMPLATE_VARIABLES_INVALID", false, attempt);
  }

  try {
    // Resend receives ordinary JavaScript Unicode strings end-to-end. Never transcode
    // template variables through binary/latin1 buffers or charset-repair hacks.
    const response = await input.provider.send({
      to: actualRecipientEmail,
      replyTo: input.config.replyTo,
      template: {
        id: snapshot.templateId,
        variables,
      },
      idempotencyKey: communicationIdempotencyKey(input.candidate.id),
    });
    if (!response.ok) {
      const failure = classifyProviderFailure(response);
      return fail(input, failure.code, failure.retryable, attempt);
    }
    await input.store.markSent(input.candidate.id, response.id, input.now);
    input.log?.(
      `COMMUNICATION_EMAIL_SENT deliveryId=${input.candidate.id} scenario=${input.candidate.scenario} recipientType=${input.candidate.recipient.recipientType}`,
    );
    return "SENT";
  } catch {
    return fail(input, "EMAIL_NETWORK_ERROR", true, attempt);
  }
}

export function communicationIdempotencyKey(deliveryId: string): string {
  return `emma-communication/${deliveryId}`;
}

function isPreActivation(candidate: CommunicationSendCandidate, activation: Date): boolean {
  return candidate.scenario === CommunicationScenario.INSPECTION_REMINDER
    ? candidate.scheduledFor.getTime() < activation.getTime()
    : candidate.event.detectedAt.getTime() < activation.getTime();
}

function snapshotString(snapshot: unknown, key: string): string | null {
  if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) return null;
  const value = (snapshot as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function fail(
  input: Parameters<typeof sendCommunicationDelivery>[0],
  reason: string,
  retryable: boolean,
  attempt: number,
): Promise<"FAILED"> {
  const nextRetryAt = retryable && attempt < MAX_ATTEMPTS
    ? new Date(input.now.getTime() + RETRY_DELAYS_MS[attempt - 1]!)
    : null;
  await input.store.markFailed(input.candidate.id, reason, input.now, nextRetryAt);
  input.log?.(
    nextRetryAt
      ? `COMMUNICATION_EMAIL_RETRY deliveryId=${input.candidate.id} attempt=${attempt} reason=${reason}`
      : `COMMUNICATION_EMAIL_FAILED deliveryId=${input.candidate.id} reason=${reason}`,
  );
  return "FAILED";
}

async function failUnclaimed(
  input: Parameters<typeof sendCommunicationDelivery>[0],
  reason: string,
): Promise<"FAILED"> {
  const claimed = await input.store.claim(
    input.candidate,
    input.now,
    input.config.mode,
    "",
  );
  if (claimed) await input.store.markFailed(input.candidate.id, reason, input.now, null);
  input.log?.(`COMMUNICATION_EMAIL_FAILED deliveryId=${input.candidate.id} reason=${reason}`);
  return "FAILED";
}

function recipientErrorCode(error: unknown): string {
  return error instanceof RecipientSafetyError ? error.code : "INVALID_RECIPIENT";
}

function templateFailure(error: unknown): { code: string; retryable: boolean } {
  return error instanceof CommunicationTemplateDataError
    ? { code: error.code, retryable: error.retryable }
    : { code: "TEMPLATE_DATA_SOURCE_ERROR", retryable: true };
}

function portalGrantFailure(error: unknown): { code: string; retryable: boolean } {
  const code = error instanceof Error ? error.message : "PORTAL_ACCESS_GRANT_FAILED";
  if (new Set([
    "MISSING_HOSPITAL_SCOPE",
    "COMMUNICATION_DELIVERY_NOT_FOUND",
    "COMMUNICATION_DELIVERY_NOT_READY",
  ]).has(code)) return { code, retryable: false };
  return { code: "PORTAL_ACCESS_GRANT_FAILED", retryable: true };
}

function classifyProviderFailure(
  response: Extract<ProviderEmailResult, { ok: false }>,
): { code: string; retryable: boolean } {
  const status = response.error.statusCode;
  const retryableNames = new Set([
    "rate_limit_exceeded",
    "concurrent_idempotent_requests",
    "application_error",
    "internal_server_error",
  ]);
  if (status === 429 || (status !== null && status >= 500) ||
      retryableNames.has(response.error.name)) {
    return {
      code: status === 429 ? "RESEND_RATE_LIMITED" : "RESEND_TRANSIENT_ERROR",
      retryable: true,
    };
  }
  return { code: "RESEND_REQUEST_REJECTED", retryable: false };
}

function parseSendSnapshot(value: unknown): PersistedCommunicationSendSnapshot | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const snapshot = value as Record<string, unknown>;
  if (typeof snapshot.templateId !== "string" ||
      typeof snapshot.portalGrantPublicId !== "string" ||
      typeof snapshot.unsubscribeGrantPublicId !== "string" ||
      typeof snapshot.preparedAt !== "string" ||
      typeof snapshot.variables !== "object" || snapshot.variables === null ||
      Array.isArray(snapshot.variables)) return null;
  const variables = Object.fromEntries(
    Object.entries(snapshot.variables).filter((entry): entry is [string, TemplateVariableValue] =>
      typeof entry[1] === "string" ||
      typeof entry[1] === "number" && Number.isFinite(entry[1])),
  );
  return {
    templateId: snapshot.templateId,
    portalGrantPublicId: snapshot.portalGrantPublicId,
    unsubscribeGrantPublicId: snapshot.unsubscribeGrantPublicId,
    preparedAt: snapshot.preparedAt,
    variables,
  };
}
