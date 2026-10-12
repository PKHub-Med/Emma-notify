import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import {
  CommunicationDeliveryCancelReason,
  CommunicationDeliveryStatus,
  CommunicationRecipientType,
  CommunicationRecipientResolutionStatus,
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
  buildCommunicationRepairBatchPayload,
  buildCommunicationTemplatePayload,
  buildBlockedClientFallbackPayload,
  buildSecureCtaHtml,
  buildUnsubscribeHtml,
  CommunicationTemplateDataError,
  type CommunicationTemplateDataSource,
} from "./communication-template-data.js";
import {
  reminderCancellationReason,
  type CurrentTaskState,
} from "./communication-delivery.js";
import type { CommunicationAssetPreflight } from "../assets/preflight.js";
import {
  compareLocalDates,
  localDateAt,
  parseLocalDate,
  repairBatchScheduledFor,
} from "./communication-time.js";
import {
  normalizeCommunicationTemplateVariables,
  REPAIR_ROW_SLOT_COUNT,
} from "./communication-template-registry.js";
import {
  assertEmailDebugTraceAvailable,
  buildEmailDebugHtml,
  debugEmailSubject,
  parseRecipientResolutionDebugTrace,
  renderDebugEmailHtml,
  type RecipientResolutionDebugTrace,
} from "./communication-email-debug.js";
import type { CommunicationDiagnosticRegistry } from "./communication-diagnostics.js";
import { normalizeEmail } from "../shared/normalize-email.js";

const MAX_ATTEMPTS = 5;
const STALE_SENDING_MS = 5 * 60_000;
const RETRY_DELAYS_MS = [5 * 60_000, 10 * 60_000, 20 * 60_000, 40 * 60_000] as const;
const CANDIDATE_LIMIT = 1000;

export type DeliveryErrorCategory = "TRANSIENT" | "PERMANENT" | "SUPPRESSED";

export type DeliveryErrorClassification = {
  category: DeliveryErrorCategory;
  code: string;
  retryable: boolean;
};

export type DeliveryErrorInput =
  | { source: "TEMPLATE_DATA"; error: unknown }
  | { source: "PORTAL_GRANT"; error: unknown }
  | { source: "PROVIDER"; response: Extract<ProviderEmailResult, { ok: false }> }
  | { source: "RECIPIENT"; error: unknown }
  | { source: "TRANSIENT"; code: string }
  | { source: "PERMANENT"; code: string }
  | { source: "SUPPRESSED"; code: string };

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
  logicalDigestKey?: string | null;
  event: {
    id?: string;
    detectedAt: Date;
    sourceRecordId: string;
    eventSnapshot: unknown;
    recipientResolutionDebug?: RecipientResolutionDebugTrace | null;
  };
  recipient: {
    recipientType: CommunicationRecipientType;
    email: string | null;
    normalizedEmail: string | null;
    resolutionReason?: string | null;
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
  claimBatch(
    candidates: readonly CommunicationSendCandidate[],
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
  markBatchSent(deliveryIds: readonly string[], messageId: string, sentAt: Date): Promise<void>;
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
  rerouteToFallback(
    deliveryIds: readonly string[],
    intendedEmail: string,
    actualEmail: string,
    reason: string,
  ): Promise<void>;
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
  mailTestMode?: boolean;
  communicationEmailsEnabled: boolean;
  communicationEmailDebug: boolean;
  communicationSendNotBefore: Date | null;
  mode: EmailMode;
  testEmail: string | null;
  productionEmailsEnabled: boolean;
  resendApiKey: string | null;
  emailFrom: string | null;
  replyTo: string;
  timeZone: string;
  communicationAssetsEnabled?: boolean;
  officeContact?: { name: string; phone: string; email: string };
  tiemedFallbackEmail: string | null;
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
        logicalDigestKey: true,
        communicationEvent: {
          select: {
            id: true,
            detectedAt: true,
            sourceRecordId: true,
            eventSnapshot: true,
            recipientResolutionDebug: true,
          },
        },
        communicationEventRecipient: {
          select: { recipientType: true, email: true, normalizedEmail: true, resolutionReason: true },
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
      logicalDigestKey: delivery.logicalDigestKey,
      event: {
        ...delivery.communicationEvent,
        recipientResolutionDebug: parseRecipientResolutionDebugTrace(
          delivery.communicationEvent.recipientResolutionDebug,
        ),
      },
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

  async claimBatch(
    candidates: readonly CommunicationSendCandidate[],
    now: Date,
    mode: EmailMode,
    actualRecipientEmail: string,
  ): Promise<boolean> {
    if (candidates.length === 0) return false;
    const staleBefore = new Date(now.getTime() - STALE_SENDING_MS);
    try {
      await this.prisma.$transaction(async (transaction) => {
        for (const candidate of candidates) {
          const state: Prisma.CommunicationDeliveryWhereInput =
            candidate.status === CommunicationDeliveryStatus.READY
              ? { status: CommunicationDeliveryStatus.READY }
              : candidate.status === CommunicationDeliveryStatus.FAILED
                ? { status: CommunicationDeliveryStatus.FAILED, nextRetryAt: { not: null, lte: now } }
                : { status: CommunicationDeliveryStatus.SENDING, sendingStartedAt: { not: null, lte: staleBefore } };
          const claimed = await transaction.communicationDelivery.updateMany({
            where: { id: candidate.id, attemptCount: candidate.attemptCount, ...state },
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
          if (claimed.count !== 1) throw new Error("BATCH_CLAIM_CONFLICT");
        }
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      return true;
    } catch {
      return false;
    }
  }

  getCurrentTask(sourceRecordId: string): Promise<CurrentTaskState | null> {
    return this.prisma.trackedTask.findFirst({
      where: { airtableRecordId: sourceRecordId, active: true },
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

  async markBatchSent(
    deliveryIds: readonly string[],
    messageId: string,
    sentAt: Date,
  ): Promise<void> {
    if (deliveryIds.length === 0) return;
    await this.prisma.$transaction([
      this.prisma.communicationDelivery.updateMany({
        where: { id: { in: [...deliveryIds] }, status: CommunicationDeliveryStatus.SENDING },
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
        where: { deliveryId: { in: [...deliveryIds] }, exposedAt: null },
        data: { exposedAt: sentAt },
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

  async rerouteToFallback(
    deliveryIds: readonly string[],
    intendedEmail: string,
    actualEmail: string,
    reason: string,
  ): Promise<void> {
    const normalizedEmail = intendedEmail.trim().toLowerCase();
    await this.prisma.$transaction(async (transaction) => {
      const deliveries = await transaction.communicationDelivery.findMany({
        where: { id: { in: [...deliveryIds] } },
        select: { id: true, communicationEventRecipientId: true },
      });
      for (const delivery of deliveries) {
        await transaction.communicationEventRecipient.update({
          where: { id: delivery.communicationEventRecipientId },
          data: {
            recipientType: CommunicationRecipientType.TIEMED_FALLBACK,
            email: intendedEmail,
            normalizedEmail,
            recipientKey: `BLOCKED:${delivery.id}:${normalizedEmail}`,
            resolutionStatus: CommunicationRecipientResolutionStatus.FALLBACK,
            resolutionReason: reason,
          },
        });
      }
      await transaction.communicationDelivery.updateMany({
        where: { id: { in: [...deliveryIds] } },
        data: { actualRecipientEmail: actualEmail, lastError: `BLOCKED_CLIENT:${reason}` },
      });
    });
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
  diagnostics?: CommunicationDiagnosticRegistry;
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
  const processed = new Set<string>();

  for (const candidate of candidates) {
    if (processed.has(candidate.id)) continue;

    if (isRepairScenario(candidate.scenario)) {
      const key = repairBatchKey(candidate);
      const matching = candidates
        .filter((item) => !processed.has(item.id) && repairBatchKey(item) === key)
        .sort((a, b) => a.id.localeCompare(b.id));

      matching.forEach((item) => processed.add(item.id));
      const outcome = await sendCommunicationRepairBatch({
        ...input,
        candidates: matching,
        now: now(),
      });
      stats.sent += outcome.sent;
      stats.failed += outcome.failed;
      stats.cancelled += outcome.cancelled;
      for (const item of matching) {
        await input.diagnostics?.synchronizeDelivery(item.id, now());
      }
      continue;
    }

    processed.add(candidate.id);
    const outcome = await sendCommunicationDelivery({ ...input, candidate, now: now() });
    if (outcome === "SENT") stats.sent += 1;
    if (outcome === "FAILED") stats.failed += 1;
    if (outcome === "CANCELLED") stats.cancelled += 1;
    if (outcome !== "SKIPPED") {
      await input.diagnostics?.synchronizeDelivery(candidate.id, now());
    }
  }
  return stats;
}

export async function sendCommunicationRepairBatch(input: {
  store: CommunicationEmailSendStore;
  provider: EmailProvider;
  grants: CommunicationPortalGrantProvider;
  unsubscribeGrants: CommunicationUnsubscribeGrantProvider;
  dataSource: CommunicationTemplateDataSource;
  assetPreflight?: CommunicationAssetPreflight;
  config: CommunicationEmailSenderConfig;
  candidates: readonly CommunicationSendCandidate[];
  now: Date;
  log?: (message: string) => void;
}): Promise<{ sent: number; failed: number; cancelled: number }> {
  const result = { sent: 0, failed: 0, cancelled: 0 };
  const activation = input.config.communicationSendNotBefore;
  if (!activation || input.candidates.length === 0) return result;

  const eligible: CommunicationSendCandidate[] = [];
  for (const candidate of input.candidates) {
    if (!input.config.mailTestMode && input.config.mode === "PRODUCTION" &&
        !input.config.communicationEmailDebug &&
        input.now.getTime() < repairBatchScheduledFor(
          candidate.event.detectedAt,
          input.config.timeZone,
          "0 6,14 * * *",
        ).getTime()) {
      continue;
    }
    if (!snapshotString(candidate.event.eventSnapshot, "sourceHospitalRecordId")) {
      const reason = isPreActivation(candidate, activation)
        ? CommunicationDeliveryCancelReason.MISSING_HOSPITAL_SCOPE_LEGACY
        : CommunicationDeliveryCancelReason.MISSING_HOSPITAL_SCOPE;
      const fallbackOutcome = !isPreActivation(candidate, activation)
        ? await sendUnscopedFallback(input, candidate) : null;
      if (fallbackOutcome === "SENT") result.sent += 1;
      else if (fallbackOutcome === "FAILED") result.failed += 1;
      else if (await input.store.cancel(candidate.id, reason, input.now)) {
        result.cancelled += 1;
        input.log?.(`COMMUNICATION_DELIVERY_CANCELLED deliveryId=${candidate.id} reason=${reason}`);
      }
      continue;
    }
    if (isPreActivation(candidate, activation)) {
      if (await input.store.cancel(
        candidate.id,
        CommunicationDeliveryCancelReason.PRE_ACTIVATION,
        input.now,
      )) result.cancelled += 1;
      input.log?.(`COMMUNICATION_EMAIL_CANCELLED deliveryId=${candidate.id} reason=PRE_ACTIVATION`);
      continue;
    }
    eligible.push(candidate);
  }
  if (eligible.length === 0) return result;

  let actualRecipientEmail: string;
  try {
    actualRecipientEmail = resolveActualRecipient({
      mode: input.config.mode,
      intendedRecipientEmail: eligible[0]!.recipient.email ?? "",
      testEmail: input.config.testEmail,
      productionEmailsEnabled: input.config.productionEmailsEnabled,
    });
    assertTestRecipient({
      mode: input.config.mode,
      actualRecipientEmail,
      testEmail: input.config.testEmail,
    });
    assertEmailDebugSafety(input.config, actualRecipientEmail, eligible);
  } catch (error: unknown) {
    const failure = classifyDeliveryError({ source: "RECIPIENT", error });
    if (failure.code === "EMAIL_DEBUG_TRACE_MISSING" && input.config.mailTestMode) {
      input.log?.("COMMUNICATION_EMAIL_BARRIER_BLOCKED reason=EMAIL_DEBUG_TRACE_MISSING");
      return result;
    }
    for (const candidate of eligible) {
      const claimed = await input.store.claim(candidate, input.now, input.config.mode, "");
      if (claimed) {
        await persistFailure(input, candidate, failure, claimedAttempt(candidate), true);
        result.failed += 1;
      }
    }
    return result;
  }

  const batchClaimed = await input.store.claimBatch(
    eligible,
    input.now,
    input.config.mode,
    actualRecipientEmail,
  );
  if (!batchClaimed) return result;
  const claimed = [...eligible];
  for (const candidate of claimed) {
    input.log?.(
      `COMMUNICATION_EMAIL_CLAIMED deliveryId=${candidate.id} scenario=${candidate.scenario} batch=true`,
    );
  }

  if (!input.config.resendApiKey) {
    await failRepairBatch(input, claimed, classifyDeliveryError({
      source: "PERMANENT", code: "RESEND_API_KEY_MISSING",
    }));
    result.failed += claimed.length;
    return result;
  }

  // The lexicographically first delivery is the deterministic owner of the
  // portal/unsubscribe links for the whole batch. Failed retries keep the same
  // owner because all deliveries in the batch fail and retry together.
  const owner = claimed.slice().sort((a, b) => a.id.localeCompare(b.id))[0]!;
  let grantResult: Awaited<ReturnType<CommunicationPortalGrantProvider["getOrCreatePortalAccessGrant"]>>;
  try {
    grantResult = await input.grants.getOrCreatePortalAccessGrant(owner.id, input.now);
  } catch (error: unknown) {
    const failure = classifyDeliveryError({ source: "PORTAL_GRANT", error });
    if (!failure.retryable && input.config.tiemedFallbackEmail) {
      const fallbackOutcome = await sendBlockedRepairBatch(input, claimed, owner,
        { url: "" }, { url: "" },
        new CommunicationTemplateDataError(failure.code, false, { code: failure.code }));
      if (fallbackOutcome === "SENT") { result.sent += claimed.length; return result; }
    }
    await failRepairBatch(input, claimed, failure);
    result.failed += claimed.length;
    return result;
  }

  let unsubscribeResult: Awaited<ReturnType<CommunicationUnsubscribeGrantProvider["getOrCreateUnsubscribeGrant"]>>;
  try {
    unsubscribeResult = await input.unsubscribeGrants.getOrCreateUnsubscribeGrant(owner.id, input.now);
  } catch (error: unknown) {
    const failure = classifyDeliveryError({ source: "PORTAL_GRANT", error });
    if (!failure.retryable && input.config.tiemedFallbackEmail) {
      const fallbackOutcome = await sendBlockedRepairBatch(input, claimed, owner,
        grantResult, { url: "" },
        new CommunicationTemplateDataError(failure.code, false, { code: failure.code }));
      if (fallbackOutcome === "SENT") { result.sent += claimed.length; return result; }
    }
    await failRepairBatch(input, claimed, failure);
    result.failed += claimed.length;
    return result;
  }

  let snapshot = owner.sendSnapshot;
  if (!snapshot) {
    try {
      let payload = await buildCommunicationRepairBatchPayload({
        deliveries: claimed.map((candidate) => ({
          id: candidate.id,
          scenario: candidate.scenario,
          sourceRecordId: candidate.event.sourceRecordId,
          eventSnapshot: candidate.event.eventSnapshot,
        })),
        dataSource: input.dataSource,
        secureUrl: grantResult.url,
        unsubscribeUrl: unsubscribeResult.url,
        preparedAt: owner.scheduledFor,
        timeZone: input.config.timeZone,
        allowMissingRepairReceivedDevice: claimedAttempt(owner) >= MAX_ATTEMPTS,
      });
      payload = addRecipientFallbackNotice(payload, claimed.map((candidate) => ({
        id: candidate.id, scenario: candidate.scenario,
        sourceRecordId: candidate.event.sourceRecordId,
        eventSnapshot: candidate.event.eventSnapshot,
      })), owner, grantResult.url, unsubscribeResult.url, input.config.timeZone,
      input.config.officeContact);
      const {
        EMMA_SECURE_URL: _secureUrl,
        EMMA_UNSUBSCRIBE_URL: _unsubscribeUrl,
        ...safeVariables
      } = payload.variables;
      const prepared: PersistedCommunicationSendSnapshot = {
        templateId: payload.templateId,
        variables: safeVariables,
        portalGrantPublicId: grantResult.grant.publicId,
        unsubscribeGrantPublicId: unsubscribeResult.grant.publicId,
        preparedAt: owner.scheduledFor.toISOString(),
      };
      for (const candidate of claimed) {
        const stored = await input.store.saveSnapshot(candidate.id, prepared, input.now);
        if (candidate.id === owner.id) snapshot = stored;
      }
      snapshot ??= prepared;
    } catch (error: unknown) {
      const failure = classifyDeliveryError({ source: "TEMPLATE_DATA", error });
      if (failure.category === "PERMANENT" &&
          error instanceof CommunicationTemplateDataError &&
          input.config.tiemedFallbackEmail) {
        const fallbackOutcome = await sendBlockedRepairBatch(input, claimed, owner, grantResult,
          unsubscribeResult, error);
        if (fallbackOutcome === "SENT") { result.sent += claimed.length; return result; }
        result.failed += claimed.length; return result;
      }
      await failRepairBatch(input, claimed, failure);
      result.failed += claimed.length;
      return result;
    }
  }

  if (snapshot.portalGrantPublicId !== grantResult.grant.publicId) {
    await failRepairBatch(input, claimed, classifyDeliveryError({
      source: "PERMANENT", code: "SEND_SNAPSHOT_GRANT_MISMATCH",
    }));
    result.failed += claimed.length;
    return result;
  }
  if (snapshot.unsubscribeGrantPublicId !== unsubscribeResult.grant.publicId) {
    await failRepairBatch(input, claimed, classifyDeliveryError({
      source: "PERMANENT", code: "SEND_SNAPSHOT_UNSUBSCRIBE_GRANT_MISMATCH",
    }));
    result.failed += claimed.length;
    return result;
  }

  if (input.config.communicationAssetsEnabled && input.assetPreflight) {
    for (const candidate of claimed) {
      await input.assetPreflight.prepare({
        id: candidate.id, scenario: candidate.scenario,
        sourceRecordId: candidate.event.sourceRecordId,
        eventSnapshot: candidate.event.eventSnapshot,
      });
    }
  }

  let variables: Record<string, TemplateVariableValue>;
  try {
    variables = normalizeCommunicationTemplateVariables(snapshot.templateId, {
      ...snapshot.variables,
      EMMA_SECURE_URL: buildSecureCtaHtml(grantResult.url, owner.scenario),
      EMMA_UNSUBSCRIBE_URL: buildUnsubscribeHtml(unsubscribeResult.url),
    });
  } catch {
    await failRepairBatch(input, claimed, classifyDeliveryError({
      source: "PERMANENT", code: "TEMPLATE_VARIABLES_INVALID",
    }));
    result.failed += claimed.length;
    return result;
  }

  try {
    const response = await input.provider.send({
      to: actualRecipientEmail,
      replyTo: input.config.replyTo,
      template: { id: snapshot.templateId, variables },
      ...communicationEmailDebugOverrides(
        input.config, claimed, actualRecipientEmail, snapshot.templateId, variables,
      ),
      idempotencyKey: communicationBatchIdempotencyKey(claimed.map((item) => item.id)),
    });
    if (!response.ok) {
      const failure = classifyDeliveryError({ source: "PROVIDER", response });
      await failRepairBatch(input, claimed, failure);
      result.failed += claimed.length;
      return result;
    }

    await input.store.markBatchSent(claimed.map((candidate) => candidate.id), response.id, input.now);
    result.sent += claimed.length;
    input.log?.(
      `COMMUNICATION_EMAIL_BATCH_SENT scenario=${owner.scenario} deliveries=${claimed.length} recipientType=${owner.recipient.recipientType}`,
    );
    return result;
  } catch {
    await failRepairBatch(input, claimed, classifyDeliveryError({
      source: "TRANSIENT", code: "EMAIL_NETWORK_ERROR",
    }));
    result.failed += claimed.length;
    return result;
  }
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
  if (input.candidate.scenario === CommunicationScenario.INSPECTION_COMPLETED &&
      input.config.mailTestMode &&
      !await isCurrentlyPerformedCompletedCandidate(
        input.candidate,
        input.dataSource,
        input.now,
        input.config.timeZone,
      )) {
    const cancelled = await input.store.cancel(
      input.candidate.id,
      CommunicationDeliveryCancelReason.HISTORICAL_COMPLETED,
      input.now,
    );
    if (cancelled) {
      input.log?.(
        `COMMUNICATION_EMAIL_BARRIER_BLOCKED deliveryId=${input.candidate.id} ` +
        `scenario=INSPECTION_COMPLETED reason=HISTORICAL_PERFORMED_INSPECTION ` +
        `status=CANCELLED cancelReason=HISTORICAL_COMPLETED`,
      );
      return "CANCELLED";
    }
    return "SKIPPED";
  }
  if (input.candidate.scenario === CommunicationScenario.INSPECTION_COMPLETED &&
      !input.config.mailTestMode &&
      !isCurrentCompletedCandidate(input.candidate, input.now, input.config.timeZone)) {
    await input.store.cancel(
      input.candidate.id,
      CommunicationDeliveryCancelReason.HISTORICAL_COMPLETED,
      input.now,
    );
    input.log?.(
      `COMMUNICATION_EMAIL_SUPPRESSED deliveryId=${input.candidate.id} ` +
      `scenario=INSPECTION_COMPLETED reason=HISTORICAL_COMPLETED`,
    );
    return "CANCELLED";
  }
  if (!snapshotString(input.candidate.event.eventSnapshot, "sourceHospitalRecordId")) {
    const reason = isPreActivation(input.candidate, activation)
      ? CommunicationDeliveryCancelReason.MISSING_HOSPITAL_SCOPE_LEGACY
      : CommunicationDeliveryCancelReason.MISSING_HOSPITAL_SCOPE;
    if (!isPreActivation(input.candidate, activation)) {
      const fallbackOutcome = await sendUnscopedFallback(input, input.candidate);
      if (fallbackOutcome) return fallbackOutcome;
    }
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
    assertEmailDebugSafety(input.config, actualRecipientEmail, [input.candidate]);
  } catch (error: unknown) {
    const reason = recipientErrorCode(error);
    if (reason === "EMAIL_DEBUG_TRACE_MISSING" && input.config.mailTestMode) {
      input.log?.(
        `COMMUNICATION_EMAIL_BARRIER_BLOCKED deliveryId=${input.candidate.id} ` +
        `reason=EMAIL_DEBUG_TRACE_MISSING`,
      );
      return "SKIPPED";
    }
    return failUnclaimed(input, reason);
  }
  if (!input.config.mailTestMode && input.config.mode === "PRODUCTION" &&
      isRepairScenario(input.candidate.scenario) &&
      input.now.getTime() < repairBatchScheduledFor(
        input.candidate.event.detectedAt,
        input.config.timeZone,
        "0 6,14 * * *",
      ).getTime()) {
    return "SKIPPED";
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
      return fail(input, classifyDeliveryError({
        source: "TRANSIENT", code: "REMINDER_VALIDATION_ERROR",
      }), attempt);
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

  if (!input.config.resendApiKey) return fail(input, classifyDeliveryError({
    source: "PERMANENT", code: "RESEND_API_KEY_MISSING",
  }), attempt);

  let grantResult: Awaited<ReturnType<CommunicationPortalGrantProvider["getOrCreatePortalAccessGrant"]>>;
  try {
    grantResult = await input.grants.getOrCreatePortalAccessGrant(
      input.candidate.id,
      input.now,
    );
  } catch (error: unknown) {
    const failure = classifyDeliveryError({ source: "PORTAL_GRANT", error });
    if (!failure.retryable && input.config.tiemedFallbackEmail) {
      return sendBlockedDelivery(input, { url: "" }, { url: "" },
        new CommunicationTemplateDataError(failure.code, false, { code: failure.code }), attempt);
    }
    return fail(input, failure, attempt);
  }

  let unsubscribeResult: Awaited<ReturnType<CommunicationUnsubscribeGrantProvider["getOrCreateUnsubscribeGrant"]>>;
  try {
    unsubscribeResult = await input.unsubscribeGrants.getOrCreateUnsubscribeGrant(
      input.candidate.id,
      input.now,
    );
  } catch (error: unknown) {
    const failure = classifyDeliveryError({ source: "PORTAL_GRANT", error });
    if (!failure.retryable && input.config.tiemedFallbackEmail) {
      return sendBlockedDelivery(input, grantResult, { url: "" },
        new CommunicationTemplateDataError(failure.code, false, { code: failure.code }), attempt);
    }
    return fail(input, failure, attempt);
  }

  let snapshot = input.candidate.sendSnapshot;
  if (!snapshot) {
    try {
      let payload = await buildCommunicationTemplatePayload({
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
        ...(input.config.officeContact ? { officeContact: input.config.officeContact } : {}),
        allowMissingRepairReceivedDevice: attempt >= MAX_ATTEMPTS,
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
      const failure = classifyDeliveryError({ source: "TEMPLATE_DATA", error });
      if (failure.category === "PERMANENT" &&
          error instanceof CommunicationTemplateDataError &&
          input.config.tiemedFallbackEmail) {
        return sendBlockedDelivery(input, grantResult, unsubscribeResult, error, attempt);
      }
      return fail(input, failure, attempt);
    }
  }
  if (snapshot.portalGrantPublicId !== grantResult.grant.publicId) {
    return fail(input, classifyDeliveryError({
      source: "PERMANENT", code: "SEND_SNAPSHOT_GRANT_MISMATCH",
    }), attempt);
  }
  if (snapshot.unsubscribeGrantPublicId !== unsubscribeResult.grant.publicId) {
    return fail(input, classifyDeliveryError({
      source: "PERMANENT", code: "SEND_SNAPSHOT_UNSUBSCRIBE_GRANT_MISMATCH",
    }), attempt);
  }

  if (input.config.communicationAssetsEnabled && input.assetPreflight) {
    await input.assetPreflight.prepare({
      id: input.candidate.id, scenario: input.candidate.scenario,
      sourceRecordId: input.candidate.event.sourceRecordId,
      eventSnapshot: input.candidate.event.eventSnapshot,
    });
  }

  let variables: Record<string, TemplateVariableValue>;
  try {
    variables = normalizeCommunicationTemplateVariables(snapshot.templateId, {
      ...snapshot.variables,
      EMMA_SECURE_URL: buildSecureCtaHtml(grantResult.url, input.candidate.scenario),
      EMMA_UNSUBSCRIBE_URL: buildUnsubscribeHtml(unsubscribeResult.url),
    });
  } catch {
    return fail(input, classifyDeliveryError({
      source: "PERMANENT", code: "TEMPLATE_VARIABLES_INVALID",
    }), attempt);
  }

  if (input.candidate.scenario === CommunicationScenario.INSPECTION_COMPLETED &&
      isEmptyCompletedVariables(variables)) {
    return fail(input, classifyDeliveryError({
      source: "TRANSIENT", code: "COMPLETED_DATA_PENDING",
    }), attempt);
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
      ...communicationEmailDebugOverrides(
        input.config, [input.candidate], actualRecipientEmail, snapshot.templateId, variables,
      ),
      idempotencyKey: communicationIdempotencyKey(
        input.candidate.logicalDigestKey ?? input.candidate.id,
      ),
    });
    if (!response.ok) {
      const failure = classifyDeliveryError({ source: "PROVIDER", response });
      return fail(input, failure, attempt);
    }
    await input.store.markSent(input.candidate.id, response.id, input.now);
    input.log?.(
      `COMMUNICATION_EMAIL_SENT deliveryId=${input.candidate.id} scenario=${input.candidate.scenario} recipientType=${input.candidate.recipient.recipientType}`,
    );
    return "SENT";
  } catch {
    return fail(input, classifyDeliveryError({
      source: "TRANSIENT", code: "EMAIL_NETWORK_ERROR",
    }), attempt);
  }
}

function isRepairScenario(scenario: CommunicationScenario): boolean {
  return scenario === CommunicationScenario.REPAIR_RECEIVED ||
    scenario === CommunicationScenario.REPAIR_DELAYED_PARTS ||
    scenario === CommunicationScenario.REPAIR_COMPLETED;
}

function resolveFallbackRecipient(config: CommunicationEmailSenderConfig, fallback: string): string {
  const actual = resolveActualRecipient({
    mode: config.mode, intendedRecipientEmail: fallback, testEmail: config.testEmail,
    productionEmailsEnabled: config.productionEmailsEnabled,
  });
  assertTestRecipient({ mode: config.mode, actualRecipientEmail: actual, testEmail: config.testEmail });
  assertEmailDebugRecipient(config, actual);
  return actual;
}

function assertEmailDebugSafety(
  config: CommunicationEmailSenderConfig,
  actualRecipientEmail: string,
  candidates: readonly CommunicationSendCandidate[],
): void {
  if (!config.communicationEmailDebug) return;
  assertEmailDebugRecipient(config, actualRecipientEmail);
  try {
    assertEmailDebugTraceAvailable(candidates);
  } catch {
    throw new RecipientSafetyError("EMAIL_DEBUG_TRACE_MISSING");
  }
}

function assertEmailDebugRecipient(
  config: CommunicationEmailSenderConfig,
  actualRecipientEmail: string,
): void {
  if (!config.communicationEmailDebug) return;
  const expected = normalizeEmail(config.testEmail ?? "");
  const actual = normalizeEmail(actualRecipientEmail);
  if (config.mode !== "TEST" || !expected || actual !== expected) {
    throw new RecipientSafetyError("DEBUG_EMAIL_UNSAFE");
  }
  if (!config.emailFrom) throw new RecipientSafetyError("DEBUG_EMAIL_FROM_MISSING");
}

function communicationEmailDebugOverrides(
  config: CommunicationEmailSenderConfig,
  candidates: readonly CommunicationSendCandidate[],
  actualRecipientEmail: string,
  templateId: string,
  variables: Record<string, TemplateVariableValue>,
): { from?: string; subject?: string; html?: string } {
  if (!config.communicationEmailDebug) return {};
  assertEmailDebugSafety(config, actualRecipientEmail, candidates);
  const debugBlock = buildEmailDebugHtml({
    candidates,
    actualTo: actualRecipientEmail,
    testEmail: config.testEmail!,
    variables,
  });
  return {
    from: config.emailFrom!,
    subject: debugEmailSubject(templateId, variables),
    html: renderDebugEmailHtml(templateId, variables, debugBlock),
  };
}

async function sendUnscopedFallback(
  input: {
    store: CommunicationEmailSendStore;
    provider: EmailProvider;
    config: CommunicationEmailSenderConfig;
    now: Date;
    log?: (message: string) => void;
  },
  candidate: CommunicationSendCandidate,
): Promise<"SENT" | "FAILED" | null> {
  const fallback = input.config.tiemedFallbackEmail;
  if (!fallback || !input.config.resendApiKey) return null;
  let actualFallback: string;
  try { actualFallback = resolveFallbackRecipient(input.config, fallback); } catch { return null; }
  try { assertEmailDebugSafety(input.config, actualFallback, [candidate]); } catch { return null; }
  const claimed = await input.store.claim(candidate, input.now, input.config.mode, actualFallback);
  if (!claimed) return null;
  const error = new CommunicationTemplateDataError("MISSING_HOSPITAL_SCOPE", false, {
    code: "MISSING_HOSPITAL_SCOPE", expected: "one hospital", found: null,
    recordIds: [candidate.event.sourceRecordId], safeRecordIds: [],
  });
  const payload = buildBlockedClientFallbackPayload({
    deliveries: [{ id: candidate.id, scenario: candidate.scenario,
      sourceRecordId: candidate.event.sourceRecordId,
      eventSnapshot: candidate.event.eventSnapshot }],
    secureUrl: "", unsubscribeUrl: "", preparedAt: input.now,
    timeZone: input.config.timeZone, error,
    ...(input.config.officeContact ? { officeContact: input.config.officeContact } : {}),
  });
  const variables = normalizeCommunicationTemplateVariables(payload.templateId, payload.variables);
  await input.store.rerouteToFallback([candidate.id], fallback, actualFallback, error.code);
  let response: ProviderEmailResult;
  try {
    response = await input.provider.send({
      to: actualFallback, replyTo: input.config.replyTo,
      template: { id: payload.templateId, variables },
      ...communicationEmailDebugOverrides(
        input.config, [candidate], actualFallback, payload.templateId, variables,
      ),
      idempotencyKey: `emma-communication-blocked-unscoped/${candidate.id}`,
    });
  } catch {
    await persistFailure(input, candidate, classifyDeliveryError({
      source: "TRANSIENT", code: "EMAIL_NETWORK_ERROR",
    }), claimedAttempt(candidate));
    return "FAILED";
  }
  if (!response.ok) {
    const failure = classifyDeliveryError({ source: "PROVIDER", response });
    await persistFailure(input, candidate, failure, claimedAttempt(candidate));
    return "FAILED";
  }
  await input.store.markSent(candidate.id, response.id, input.now);
  input.log?.(`COMMUNICATION_BLOCKED_CLIENT_FALLBACK_SENT deliveryId=${candidate.id} code=${error.code}`);
  return "SENT";
}

function addRecipientFallbackNotice(
  payload: { templateId: string; variables: Record<string, TemplateVariableValue> },
  deliveries: Parameters<typeof buildBlockedClientFallbackPayload>[0]["deliveries"],
  candidate: CommunicationSendCandidate,
  secureUrl: string,
  unsubscribeUrl: string,
  timeZone: string,
  officeContact?: CommunicationEmailSenderConfig["officeContact"],
) {
  if (candidate.recipient.recipientType !== CommunicationRecipientType.TIEMED_FALLBACK) {
    return payload;
  }
  const rawReason = candidate.recipient.resolutionReason ?? "NO_VALID_CLIENT_EMAIL";
  const exhaustedContactRead = /^AIRTABLE_CONTACT_READ_FAILED:(\d+)$/.exec(rawReason);
  const reason = exhaustedContactRead ? "AIRTABLE_CONTACT_READ_FAILED" : rawReason;
  const diagnostic = buildBlockedClientFallbackPayload({
    deliveries, secureUrl, unsubscribeUrl, preparedAt: candidate.scheduledFor,
    timeZone, error: new CommunicationTemplateDataError(reason, false, {
      code: reason,
      ...(exhaustedContactRead ? { found: {
        failedAttempts: Number(exhaustedContactRead[1]),
      }, failedAttemptCount: Number(exhaustedContactRead[1]) } : {}),
    }),
    ...(officeContact ? { officeContact } : {}),
  });
  return { ...payload, variables: {
    ...payload.variables, BLOCKED_NOTICE: diagnostic.variables.BLOCKED_NOTICE ?? "",
  } };
}

async function sendBlockedDelivery(
  input: Parameters<typeof sendCommunicationDelivery>[0],
  grantResult: { url: string },
  unsubscribeResult: { url: string },
  error: CommunicationTemplateDataError,
  attempt: number,
): Promise<"SENT" | "FAILED" | "CANCELLED"> {
  const fallback = input.config.tiemedFallbackEmail;
  if (!fallback) return "FAILED";
  let payload = buildBlockedClientFallbackPayload({
    deliveries: [{ id: input.candidate.id, scenario: input.candidate.scenario,
      sourceRecordId: input.candidate.event.sourceRecordId,
      eventSnapshot: input.candidate.event.eventSnapshot }],
    secureUrl: grantResult.url, unsubscribeUrl: unsubscribeResult.url,
    preparedAt: input.now, timeZone: input.config.timeZone, error,
    ...(input.config.officeContact ? { officeContact: input.config.officeContact } : {}),
  });
  if (!isRepairScenario(input.candidate.scenario) && error.diagnostic?.safeRecordIds) {
    try {
      const safeSnapshot = {
        ...(input.candidate.event.eventSnapshot as Record<string, unknown>),
        linkedInspectionRecordIds: [...error.diagnostic.safeRecordIds],
      };
      const safePayload = await buildCommunicationTemplatePayload({
        delivery: { id: input.candidate.id, scenario: input.candidate.scenario,
          sourceRecordId: input.candidate.event.sourceRecordId, eventSnapshot: safeSnapshot },
        dataSource: input.dataSource, secureUrl: grantResult.url,
        unsubscribeUrl: unsubscribeResult.url, preparedAt: input.now,
        timeZone: input.config.timeZone,
        ...(input.config.officeContact ? { officeContact: input.config.officeContact } : {}),
      });
      payload = addRecipientFallbackNotice(payload, [{ id: input.candidate.id,
        scenario: input.candidate.scenario, sourceRecordId: input.candidate.event.sourceRecordId,
        eventSnapshot: input.candidate.event.eventSnapshot }], input.candidate,
      grantResult.url, unsubscribeResult.url, input.config.timeZone,
      input.config.officeContact);
      payload = { ...safePayload, variables: {
        ...safePayload.variables,
        BLOCKED_NOTICE: payload.variables.BLOCKED_NOTICE ?? "",
      } };
    } catch { /* Generic diagnostic-only payload remains safe. */ }
  }
  const actualFallback = resolveFallbackRecipient(input.config, fallback);
  const variables = normalizeCommunicationTemplateVariables(payload.templateId, payload.variables);
  await input.store.rerouteToFallback([input.candidate.id], fallback, actualFallback, error.code);
  let response: ProviderEmailResult;
  try {
    response = await input.provider.send({
      to: actualFallback, replyTo: input.config.replyTo,
      template: { id: payload.templateId, variables },
      ...communicationEmailDebugOverrides(
        input.config, [input.candidate], actualFallback, payload.templateId, variables,
      ),
      idempotencyKey: `emma-communication-blocked/${input.candidate.event.sourceRecordId}/${input.candidate.scenario}`,
    });
  } catch {
    await fail(input, classifyDeliveryError({
      source: "TRANSIENT", code: "EMAIL_NETWORK_ERROR",
    }), attempt);
    return "FAILED";
  }
  if (!response.ok) {
    const failure = classifyDeliveryError({ source: "PROVIDER", response });
    await fail(input, failure, attempt);
    return "FAILED";
  }
  await input.store.markSent(input.candidate.id, response.id, input.now);
  input.log?.(`COMMUNICATION_BLOCKED_CLIENT_FALLBACK_SENT deliveryId=${input.candidate.id} code=${error.code}`);
  return "SENT";
}

async function sendBlockedRepairBatch(
  input: Parameters<typeof sendCommunicationRepairBatch>[0],
  candidates: readonly CommunicationSendCandidate[],
  owner: CommunicationSendCandidate,
  grantResult: { url: string },
  unsubscribeResult: { url: string },
  error: CommunicationTemplateDataError,
): Promise<"SENT" | "FAILED"> {
  const fallback = input.config.tiemedFallbackEmail;
  if (!fallback) return "FAILED";
  const payload = buildBlockedClientFallbackPayload({
    deliveries: candidates.map((candidate) => ({ id: candidate.id,
      scenario: candidate.scenario, sourceRecordId: candidate.event.sourceRecordId,
      eventSnapshot: candidate.event.eventSnapshot })),
    secureUrl: grantResult.url, unsubscribeUrl: unsubscribeResult.url,
    preparedAt: owner.scheduledFor, timeZone: input.config.timeZone, error,
    ...(input.config.officeContact ? { officeContact: input.config.officeContact } : {}),
  });
  const ids = candidates.map((candidate) => candidate.id);
  const actualFallback = resolveFallbackRecipient(input.config, fallback);
  const variables = normalizeCommunicationTemplateVariables(payload.templateId, payload.variables);
  await input.store.rerouteToFallback(ids, fallback, actualFallback, error.code);
  let response: ProviderEmailResult;
  try {
    response = await input.provider.send({
      to: actualFallback, replyTo: input.config.replyTo,
      template: { id: payload.templateId, variables },
      ...communicationEmailDebugOverrides(
        input.config, candidates, actualFallback, payload.templateId, variables,
      ),
      idempotencyKey: `${communicationBatchIdempotencyKey(ids)}-blocked`,
    });
  } catch {
    await failRepairBatch(input, candidates, classifyDeliveryError({
      source: "TRANSIENT", code: "EMAIL_NETWORK_ERROR",
    }));
    return "FAILED";
  }
  if (!response.ok) {
    const failure = classifyDeliveryError({ source: "PROVIDER", response });
    await failRepairBatch(input, candidates, failure);
    return "FAILED";
  }
  await input.store.markBatchSent(ids, response.id, input.now);
  input.log?.(`COMMUNICATION_BLOCKED_CLIENT_FALLBACK_SENT deliveries=${ids.length} code=${error.code}`);
  return "SENT";
}

function repairBatchKey(candidate: CommunicationSendCandidate): string {
  const hospital = snapshotString(candidate.event.eventSnapshot, "sourceHospitalRecordId") ?? "";
  const recipient = (candidate.recipient.normalizedEmail ?? candidate.recipient.email ?? "")
    .trim()
    .toLowerCase();
  return [candidate.scenario, candidate.scheduledFor.toISOString(), hospital, recipient].join("|");
}

export function communicationBatchIdempotencyKey(deliveryIds: readonly string[]): string {
  const stableIds = [...deliveryIds].sort().join(".");
  // A compact deterministic hash keeps the provider idempotency key well below
  // header-size limits even for large hospital batches.
  let hash = 2166136261;
  for (let index = 0; index < stableIds.length; index += 1) {
    hash ^= stableIds.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `emma-communication-batch/${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

async function failRepairBatch(
  input: Parameters<typeof sendCommunicationRepairBatch>[0],
  candidates: readonly CommunicationSendCandidate[],
  failure: DeliveryErrorClassification,
): Promise<void> {
  for (const candidate of candidates) {
    // Prisma claims increment the persisted attempt count without mutating the
    // fetched candidate object, while in-memory/test stores may mutate it.
    // Support both semantics so the selected retry policy receives the real attempt number.
    const attempt = claimedAttempt(candidate);
    await persistFailure(input, candidate, failure, attempt, true);
  }
}

export function communicationIdempotencyKey(deliveryId: string): string {
  return `emma-communication/${deliveryId}`;
}

export function isCurrentCompletedCandidate(
  candidate: Pick<CommunicationSendCandidate, "scenario" | "event">,
  now: Date,
  timeZone: string,
): boolean {
  if (candidate.scenario !== CommunicationScenario.INSPECTION_COMPLETED) return true;
  const snapshot = candidate.event.eventSnapshot;
  const day = typeof snapshot === "object" && snapshot !== null && !Array.isArray(snapshot)
    ? (snapshot as Record<string, unknown>).day
    : undefined;
  const businessDate = parseLocalDate(day);
  return businessDate !== null &&
    compareLocalDates(businessDate, localDateAt(now, timeZone)) === 0;
}

export async function isCurrentlyPerformedCompletedCandidate(
  candidate: Pick<CommunicationSendCandidate, "scenario" | "event">,
  dataSource: CommunicationTemplateDataSource,
  now: Date,
  timeZone: string,
): Promise<boolean> {
  if (candidate.scenario !== CommunicationScenario.INSPECTION_COMPLETED) return true;
  const snapshot = candidate.event.eventSnapshot;
  const recordIds = typeof snapshot === "object" && snapshot !== null && !Array.isArray(snapshot)
    ? (snapshot as Record<string, unknown>).linkedInspectionRecordIds
    : null;
  if (!Array.isArray(recordIds) || recordIds.length === 0 ||
      recordIds.some((id) => typeof id !== "string" || !id.trim())) return false;
  try {
    const inspections = await dataSource.getInspections(recordIds as string[]);
    if (inspections.length !== recordIds.length) return false;
    const today = localDateAt(now, timeZone);
    return inspections.every((inspection) => inspection.inspectionPerformedAt !== null &&
      compareLocalDates(localDateAt(inspection.inspectionPerformedAt, timeZone), today) === 0);
  } catch {
    return false;
  }
}

function isEmptyCompletedVariables(variables: Record<string, TemplateVariableValue>): boolean {
  return ["PASSED_COUNT", "CONDITIONAL_COUNT", "FAILED_COUNT"]
    .every((key) => Number(variables[key] ?? 0) === 0);
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
  failure: DeliveryErrorClassification,
  attempt: number,
): Promise<"FAILED"> {
  await persistFailure(input, input.candidate, failure, attempt);
  return "FAILED";
}

async function persistFailure(
  input: Pick<Parameters<typeof sendCommunicationDelivery>[0], "store" | "now" | "log">,
  candidate: CommunicationSendCandidate,
  failure: DeliveryErrorClassification,
  attempt: number,
  batch = false,
): Promise<void> {
  const nextRetryAt = failure.category === "TRANSIENT" && attempt < MAX_ATTEMPTS
    ? new Date(input.now.getTime() + retryDelayMs(attempt))
    : null;
  await input.store.markFailed(candidate.id, failure.code, input.now, nextRetryAt);
  const event = nextRetryAt ? "COMMUNICATION_EMAIL_RETRY" : "COMMUNICATION_EMAIL_FAILED";
  input.log?.(
    `${event} scenario=${candidate.scenario} communicationEventId=${candidate.event.id ?? "unknown"} ` +
    `deliveryId=${candidate.id} sourceRecordId=${candidate.event.sourceRecordId} ` +
    `errorCategory=${failure.category} errorCode=${failure.code} attempt=${attempt} ` +
    `maxAttempts=${MAX_ATTEMPTS} nextAttemptAt=${nextRetryAt?.toISOString() ?? "none"} ` +
    `${deliveryDiagnosticFields(candidate)}${batch ? " batch=true" : ""}`,
  );
}

function claimedAttempt(candidate: CommunicationSendCandidate): number {
  // Prisma increments the persisted count without mutating the fetched object;
  // in-memory stores used by tests mutate both status and count during claim.
  return candidate.status === CommunicationDeliveryStatus.SENDING
    ? candidate.attemptCount
    : candidate.attemptCount + 1;
}

function retryDelayMs(attempt: number): number {
  return RETRY_DELAYS_MS[attempt - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]!;
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
  if (claimed) {
    await persistFailure(input, input.candidate, classifyDeliveryError({
      source: "PERMANENT", code: reason,
    }), claimedAttempt(input.candidate));
  }
  return "FAILED";
}

function recipientErrorCode(error: unknown): string {
  return classifyDeliveryError({ source: "RECIPIENT", error }).code;
}

export function classifyDeliveryError(input: DeliveryErrorInput): DeliveryErrorClassification {
  if (input.source === "TRANSIENT") {
    return { category: "TRANSIENT", code: input.code, retryable: true };
  }
  if (input.source === "PERMANENT") {
    return { category: "PERMANENT", code: input.code, retryable: false };
  }
  if (input.source === "SUPPRESSED") {
    return { category: "SUPPRESSED", code: input.code, retryable: false };
  }
  if (input.source === "RECIPIENT") {
    const code = input.error instanceof RecipientSafetyError
      ? input.error.code : "INVALID_RECIPIENT";
    return { category: "PERMANENT", code, retryable: false };
  }
  if (input.source === "PORTAL_GRANT") {
    const code = input.error instanceof Error
      ? input.error.message : "PORTAL_ACCESS_GRANT_FAILED";
    if (new Set([
      "MISSING_HOSPITAL_SCOPE",
      "COMMUNICATION_DELIVERY_NOT_FOUND",
      "COMMUNICATION_DELIVERY_NOT_READY",
    ]).has(code)) return { category: "PERMANENT", code, retryable: false };
    return { category: "TRANSIENT", code: "PORTAL_ACCESS_GRANT_FAILED", retryable: true };
  }
  if (input.source === "PROVIDER") {
    const status = input.response.error.statusCode;
    const retryableNames = new Set([
      "rate_limit_exceeded",
      "concurrent_idempotent_requests",
      "application_error",
      "internal_server_error",
    ]);
    if (status === 429 || (status !== null && status >= 500) ||
        retryableNames.has(input.response.error.name)) {
      return {
        category: "TRANSIENT",
        code: status === 429 ? "RESEND_RATE_LIMITED" : "RESEND_TRANSIENT_ERROR",
        retryable: true,
      };
    }
    return { category: "PERMANENT", code: "RESEND_REQUEST_REJECTED", retryable: false };
  }

  if (!(input.error instanceof CommunicationTemplateDataError)) {
    return { category: "TRANSIENT", code: "TEMPLATE_DATA_SOURCE_ERROR", retryable: true };
  }
  const transientTemplateCodes = new Set([
    "TEMPLATE_DATA_SOURCE_ERROR",
    "INSPECTION_SET_INCOMPLETE",
    "INSPECTION_HOSPITAL_SCOPE_MISMATCH",
    "INSPECTION_STATE_INCONSISTENT",
    "INSPECTION_RESULT_INCOMPLETE",
    "NO_COMPLETED_INSPECTIONS",
    "REPAIR_DEVICE_DATA_PENDING",
  ]);
  const transient = input.error.retryable || transientTemplateCodes.has(input.error.code);
  return {
    category: transient ? "TRANSIENT" : "PERMANENT",
    code: input.error.code,
    retryable: transient,
  };
}

function deliveryDiagnosticFields(candidate: CommunicationSendCandidate): string {
  const snapshot = candidate.event.eventSnapshot;
  const linkedIds = typeof snapshot === "object" && snapshot !== null && !Array.isArray(snapshot) &&
      Array.isArray((snapshot as Record<string, unknown>).linkedInspectionRecordIds)
    ? (snapshot as Record<string, unknown>).linkedInspectionRecordIds as unknown[] : [];
  const safeLinkedIds = linkedIds.filter((value): value is string =>
    typeof value === "string" && value.trim().length > 0);
  return `linkedInspectionRecordIds=${JSON.stringify(safeLinkedIds)} ` +
    `sourceHospitalRecordId=${snapshotString(snapshot, "sourceHospitalRecordId") ?? "none"}`;
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
