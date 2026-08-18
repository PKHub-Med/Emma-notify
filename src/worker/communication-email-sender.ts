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
  buildCommunicationRepairBatchPayload,
  buildCommunicationTemplatePayload,
  CommunicationTemplateDataError,
  type CommunicationTemplateDataSource,
} from "./communication-template-data.js";
import {
  reminderCancellationReason,
  type CurrentTaskState,
} from "./communication-delivery.js";
import type { CommunicationAssetPreflight } from "../assets/preflight.js";
import {
  normalizeCommunicationTemplateVariables,
  REPAIR_ROW_SLOT_COUNT,
} from "./communication-template-registry.js";

const MAX_ATTEMPTS = 4;
const STALE_SENDING_MS = 5 * 60_000;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 15 * 60_000] as const;
const CANDIDATE_LIMIT = 1000;

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
  officeContact?: { name: string; phone: string; email: string };
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
  const processed = new Set<string>();

  for (const candidate of candidates) {
    if (processed.has(candidate.id)) continue;

    if (isRepairScenario(candidate.scenario)) {
      const key = repairBatchKey(candidate);
      const matching = candidates
        .filter((item) => !processed.has(item.id) && repairBatchKey(item) === key)
        .sort((a, b) => a.id.localeCompare(b.id));

      for (let offset = 0; offset < matching.length; offset += REPAIR_ROW_SLOT_COUNT) {
        const batch = matching.slice(offset, offset + REPAIR_ROW_SLOT_COUNT);
        batch.forEach((item) => processed.add(item.id));

        const outcome = await sendCommunicationRepairBatch({
          ...input,
          candidates: batch,
          now: now(),
        });
        stats.sent += outcome.sent;
        stats.failed += outcome.failed;
        stats.cancelled += outcome.cancelled;
      }
      continue;
    }

    processed.add(candidate.id);
    const outcome = await sendCommunicationDelivery({ ...input, candidate, now: now() });
    if (outcome === "SENT") stats.sent += 1;
    if (outcome === "FAILED") stats.failed += 1;
    if (outcome === "CANCELLED") stats.cancelled += 1;
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
    if (!snapshotString(candidate.event.eventSnapshot, "sourceHospitalRecordId")) {
      const reason = isPreActivation(candidate, activation)
        ? CommunicationDeliveryCancelReason.MISSING_HOSPITAL_SCOPE_LEGACY
        : CommunicationDeliveryCancelReason.MISSING_HOSPITAL_SCOPE;
      if (await input.store.cancel(candidate.id, reason, input.now)) result.cancelled += 1;
      input.log?.(`COMMUNICATION_DELIVERY_CANCELLED deliveryId=${candidate.id} reason=${reason}`);
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
  } catch (error: unknown) {
    const reason = recipientErrorCode(error);
    for (const candidate of eligible) {
      const claimed = await input.store.claim(candidate, input.now, input.config.mode, "");
      if (claimed) {
        await input.store.markFailed(candidate.id, reason, input.now, null);
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

  if (input.config.communicationAssetsEnabled && input.assetPreflight) {
    for (const candidate of claimed) {
      await input.assetPreflight.prepare({
        id: candidate.id,
        scenario: candidate.scenario,
        sourceRecordId: candidate.event.sourceRecordId,
        eventSnapshot: candidate.event.eventSnapshot,
      });
    }
  }

  if (!input.config.resendApiKey) {
    await failRepairBatch(input, claimed, "RESEND_API_KEY_MISSING", false);
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
    const failure = portalGrantFailure(error);
    await failRepairBatch(input, claimed, failure.code, failure.retryable);
    result.failed += claimed.length;
    return result;
  }

  let unsubscribeResult: Awaited<ReturnType<CommunicationUnsubscribeGrantProvider["getOrCreateUnsubscribeGrant"]>>;
  try {
    unsubscribeResult = await input.unsubscribeGrants.getOrCreateUnsubscribeGrant(owner.id, input.now);
  } catch (error: unknown) {
    const failure = portalGrantFailure(error);
    await failRepairBatch(input, claimed, failure.code, failure.retryable);
    result.failed += claimed.length;
    return result;
  }

  let snapshot = owner.sendSnapshot;
  if (!snapshot) {
    try {
      const payload = await buildCommunicationRepairBatchPayload({
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
      });
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
      const failure = templateFailure(error);
      await failRepairBatch(input, claimed, failure.code, failure.retryable);
      result.failed += claimed.length;
      return result;
    }
  }

  if (snapshot.portalGrantPublicId !== grantResult.grant.publicId) {
    await failRepairBatch(input, claimed, "SEND_SNAPSHOT_GRANT_MISMATCH", false);
    result.failed += claimed.length;
    return result;
  }
  if (snapshot.unsubscribeGrantPublicId !== unsubscribeResult.grant.publicId) {
    await failRepairBatch(input, claimed, "SEND_SNAPSHOT_UNSUBSCRIBE_GRANT_MISMATCH", false);
    result.failed += claimed.length;
    return result;
  }

  let variables: Record<string, TemplateVariableValue>;
  try {
    variables = normalizeCommunicationTemplateVariables(snapshot.templateId, {
      ...snapshot.variables,
      EMMA_SECURE_URL: grantResult.url,
      EMMA_UNSUBSCRIBE_URL: unsubscribeResult.url,
    });
  } catch {
    await failRepairBatch(input, claimed, "TEMPLATE_VARIABLES_INVALID", false);
    result.failed += claimed.length;
    return result;
  }

  try {
    const response = await input.provider.send({
      to: actualRecipientEmail,
      replyTo: input.config.replyTo,
      template: { id: snapshot.templateId, variables },
      idempotencyKey: communicationBatchIdempotencyKey(claimed.map((item) => item.id)),
    });
    if (!response.ok) {
      const failure = classifyProviderFailure(response);
      await failRepairBatch(input, claimed, failure.code, failure.retryable);
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
    await failRepairBatch(input, claimed, "EMAIL_NETWORK_ERROR", true);
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
        ...(input.config.officeContact ? { officeContact: input.config.officeContact } : {}),
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

function isRepairScenario(scenario: CommunicationScenario): boolean {
  return scenario === CommunicationScenario.REPAIR_RECEIVED ||
    scenario === CommunicationScenario.REPAIR_COMPLETED;
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
  reason: string,
  retryable: boolean,
): Promise<void> {
  for (const candidate of candidates) {
    // Prisma claims increment the persisted attempt count without mutating the
    // fetched candidate object, while in-memory/test stores may mutate it.
    // Support both semantics so retry timing remains 1/5/15 minutes.
    const attempt = candidate.status === CommunicationDeliveryStatus.SENDING
      ? candidate.attemptCount
      : candidate.attemptCount + 1;
    const nextRetryAt = retryable && attempt < MAX_ATTEMPTS
      ? new Date(input.now.getTime() + RETRY_DELAYS_MS[attempt - 1]!)
      : null;
    await input.store.markFailed(candidate.id, reason, input.now, nextRetryAt);
    input.log?.(
      nextRetryAt
        ? `COMMUNICATION_EMAIL_RETRY deliveryId=${candidate.id} attempt=${attempt} reason=${reason} batch=true`
        : `COMMUNICATION_EMAIL_FAILED deliveryId=${candidate.id} reason=${reason} batch=true`,
    );
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
