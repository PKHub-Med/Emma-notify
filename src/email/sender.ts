import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import { DigestStatus, DigestType } from "../generated/prisma/enums.js";
import { renderCaseDigest } from "./render-case-digest.js";
import {
  assertTestRecipient,
  RecipientSafetyError,
  resolveActualRecipient,
  type EmailMode,
} from "./recipient.js";
import type { EmailProvider, ProviderEmailResult } from "./resend-client.js";

const MAX_ATTEMPTS = 3;
const STALE_SENDING_MS = 5 * 60_000;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000] as const;

export type DigestCandidate = {
  id: string;
  type: "CASE_DIGEST";
  status: "CREATED" | "SENDING" | "FAILED";
  intendedRecipientEmail: string;
  subject: string;
  itemsCount: number;
  sendAttempts: number;
  sendingStartedAt: Date | null;
  nextRetryAt: Date | null;
  items: { snapshot: unknown; changes: unknown }[];
};

export type EmailSenderConfig = {
  mode: EmailMode;
  testEmail: string | null;
  productionEmailsEnabled: boolean;
  resendApiKey: string | null;
  emailFrom: string | null;
};

export type SendOutcome =
  | { outcome: "SENT"; attempt: number }
  | { outcome: "FAILED"; code: string; retryAt: Date | null }
  | { outcome: "SKIPPED" };

export interface DigestSendStore {
  findCandidates(now: Date, limit: number): Promise<DigestCandidate[]>;
  claim(
    digest: DigestCandidate,
    now: Date,
    actualRecipientEmail: string | null,
  ): Promise<boolean>;
  markSent(digestId: string, resendEmailId: string, now: Date): Promise<void>;
  markFailed(
    digestId: string,
    code: string,
    failedAt: Date,
    nextRetryAt: Date | null,
  ): Promise<void>;
}

export class PrismaDigestSendStore implements DigestSendStore {
  constructor(private readonly prisma: PrismaClient) {}

  async findCandidates(now: Date, limit: number): Promise<DigestCandidate[]> {
    const staleBefore = new Date(now.getTime() - STALE_SENDING_MS);
    return this.prisma.digest.findMany({
      where: {
        type: DigestType.CASE_DIGEST,
        sendAttempts: { lt: MAX_ATTEMPTS },
        OR: [
          { status: DigestStatus.CREATED },
          {
            status: DigestStatus.FAILED,
            nextRetryAt: { not: null, lte: now },
          },
          {
            status: DigestStatus.SENDING,
            sendingStartedAt: { not: null, lte: staleBefore },
          },
        ],
      },
      orderBy: { createdAt: "asc" },
      take: limit,
      select: {
        id: true,
        type: true,
        status: true,
        intendedRecipientEmail: true,
        subject: true,
        itemsCount: true,
        sendAttempts: true,
        sendingStartedAt: true,
        nextRetryAt: true,
        items: {
          orderBy: { createdAt: "asc" },
          select: { snapshot: true, changes: true },
        },
      },
    }) as Promise<DigestCandidate[]>;
  }

  async claim(
    digest: DigestCandidate,
    now: Date,
    actualRecipientEmail: string | null,
  ): Promise<boolean> {
    const staleBefore = new Date(now.getTime() - STALE_SENDING_MS);
    const stateCondition: Prisma.DigestWhereInput = digest.status === "CREATED"
      ? { status: DigestStatus.CREATED }
      : digest.status === "FAILED"
        ? {
            status: DigestStatus.FAILED,
            nextRetryAt: { not: null, lte: now },
          }
        : {
            status: DigestStatus.SENDING,
            sendingStartedAt: { not: null, lte: staleBefore },
          };
    const claimed = await this.prisma.digest.updateMany({
      where: {
        id: digest.id,
        type: DigestType.CASE_DIGEST,
        sendAttempts: digest.sendAttempts,
        ...stateCondition,
      },
      data: {
        status: DigestStatus.SENDING,
        sendingStartedAt: now,
        failedAt: null,
        nextRetryAt: null,
        actualRecipientEmail,
        sendAttempts: { increment: 1 },
      },
    });
    return claimed.count === 1;
  }

  async markSent(
    digestId: string,
    resendEmailId: string,
    now: Date,
  ): Promise<void> {
    await this.prisma.digest.updateMany({
      where: { id: digestId, status: DigestStatus.SENDING },
      data: {
        status: DigestStatus.SENT,
        resendEmailId,
        sentAt: now,
        failedAt: null,
        nextRetryAt: null,
        lastError: null,
      },
    });
  }

  async markFailed(
    digestId: string,
    code: string,
    failedAt: Date,
    nextRetryAt: Date | null,
  ): Promise<void> {
    await this.prisma.digest.updateMany({
      where: { id: digestId, status: DigestStatus.SENDING },
      data: {
        status: DigestStatus.FAILED,
        failedAt,
        lastError: code,
        nextRetryAt,
      },
    });
  }
}

export async function runEmailLoop(input: {
  store: DigestSendStore;
  provider: EmailProvider;
  config: EmailSenderConfig;
  now?: Date;
  limit?: number;
  log?: (message: string) => void;
}): Promise<{ candidates: number; sent: number; failed: number }> {
  const now = input.now ?? new Date();
  const candidates = await input.store.findCandidates(now, input.limit ?? 10);
  const stats = { candidates: candidates.length, sent: 0, failed: 0 };
  for (const digest of candidates) {
    const result = await sendDigest({ ...input, digest, now });
    if (result.outcome === "SENT") stats.sent += 1;
    if (result.outcome === "FAILED") stats.failed += 1;
  }
  return stats;
}

export async function sendDigest(input: {
  store: DigestSendStore;
  provider: EmailProvider;
  config: EmailSenderConfig;
  digest: DigestCandidate;
  now?: Date;
  log?: (message: string) => void;
}): Promise<SendOutcome> {
  const now = input.now ?? new Date();
  const attempt = input.digest.sendAttempts + 1;
  let actualRecipientEmail: string | null = null;
  let preflightError: string | null = null;

  try {
    actualRecipientEmail = resolveActualRecipient({
      mode: input.config.mode,
      intendedRecipientEmail: input.digest.intendedRecipientEmail,
      testEmail: input.config.testEmail,
      productionEmailsEnabled: input.config.productionEmailsEnabled,
    });
  } catch (error: unknown) {
    preflightError = safeRecipientCode(error);
  }
  if (!preflightError && !input.config.emailFrom) preflightError = "EMAIL_FROM_MISSING";
  if (!preflightError && !input.config.resendApiKey) preflightError = "RESEND_API_KEY_MISSING";

  const claimed = await input.store.claim(input.digest, now, actualRecipientEmail);
  if (!claimed) return { outcome: "SKIPPED" };

  if (preflightError) {
    return fail(input, preflightError, false, attempt, now);
  }

  try {
    assertTestRecipient({
      mode: input.config.mode,
      actualRecipientEmail: actualRecipientEmail as string,
      testEmail: input.config.testEmail,
    });
  } catch {
    return fail(input, "TEST_RECIPIENT_GUARD_FAILED", false, attempt, now);
  }

  const rendered = renderCaseDigest({
    mode: input.config.mode,
    intendedRecipientEmail: input.digest.intendedRecipientEmail,
    items: input.digest.items,
  });
  const subject = input.config.mode === "TEST"
    ? `[TEST] ${input.digest.subject}`
    : input.digest.subject;

  try {
    const response = await input.provider.send({
      from: input.config.emailFrom as string,
      to: actualRecipientEmail as string,
      subject,
      html: rendered.html,
      text: rendered.text,
      idempotencyKey: idempotencyKey(input.digest.id),
    });
    if (!response.ok) {
      const failure = classifyProviderFailure(response);
      return fail(input, failure.code, failure.retryable, attempt, now);
    }
    await input.store.markSent(input.digest.id, response.id, now);
    input.log?.(
      `[email] sent digestId=${input.digest.id} type=CASE_DIGEST mode=${input.config.mode} itemsCount=${input.digest.itemsCount} attempt=${attempt}`,
    );
    return { outcome: "SENT", attempt };
  } catch {
    return fail(input, "EMAIL_NETWORK_ERROR", true, attempt, now);
  }
}

export function idempotencyKey(digestId: string): string {
  return `emma-digest/${digestId}`;
}

async function fail(
  input: {
    store: DigestSendStore;
    digest: DigestCandidate;
    log?: (message: string) => void;
  },
  code: string,
  retryable: boolean,
  attempt: number,
  now: Date,
): Promise<SendOutcome> {
  const retryAt = retryable && attempt < MAX_ATTEMPTS
    ? new Date(now.getTime() + RETRY_DELAYS_MS[attempt - 1]!)
    : null;
  await input.store.markFailed(input.digest.id, code, now, retryAt);
  input.log?.(
    `[email] failed digestId=${input.digest.id} type=CASE_DIGEST code=${code} attempt=${attempt}`,
  );
  return { outcome: "FAILED", code, retryAt };
}

function safeRecipientCode(error: unknown): string {
  return error instanceof RecipientSafetyError
    ? error.code
    : "INVALID_RECIPIENT";
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
