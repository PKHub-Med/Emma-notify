import { describe, expect, it } from "vitest";
import {
  idempotencyKey,
  sendDigest,
  type DigestCandidate,
  type DigestSendStore,
  type EmailSenderConfig,
} from "./sender.js";
import type { EmailProvider, ProviderEmailRequest, ProviderEmailResult } from "./resend-client.js";
import type { DigestAccessLinkProvider } from "../access-links/service.js";

const now = new Date("2026-08-08T18:00:00.000Z");

class MemoryStore implements DigestSendStore {
  status = "CREATED";
  actualRecipientEmail: string | null = null;
  sendAttempts = 0;
  resendEmailId: string | null = null;
  lastError: string | null = null;
  nextRetryAt: Date | null = null;

  async findCandidates(): Promise<DigestCandidate[]> { return []; }

  async claim(
    digest: DigestCandidate,
    _claimedAt: Date,
    actualRecipientEmail: string | null,
  ): Promise<boolean> {
    if (this.status === "SENT" || this.status === "CANCELLED") return false;
    this.status = "SENDING";
    this.actualRecipientEmail = actualRecipientEmail;
    this.sendAttempts += 1;
    digest.status = "SENDING";
    digest.sendAttempts = this.sendAttempts;
    return true;
  }

  async markSent(_id: string, resendEmailId: string): Promise<void> {
    this.status = "SENT";
    this.resendEmailId = resendEmailId;
    this.lastError = null;
  }

  async markFailed(
    _id: string,
    code: string,
    _failedAt: Date,
    nextRetryAt: Date | null,
  ): Promise<void> {
    this.status = "FAILED";
    this.lastError = code;
    this.nextRetryAt = nextRetryAt;
  }
}

class MockProvider implements EmailProvider {
  readonly requests: ProviderEmailRequest[] = [];

  constructor(private readonly results: ProviderEmailResult[] = [{ ok: true, id: "resend-1" }]) {}

  async send(request: ProviderEmailRequest): Promise<ProviderEmailResult> {
    this.requests.push(request);
    return this.results.shift() ?? { ok: true, id: "resend-fallback" };
  }
}

class FixedAccessLinks implements DigestAccessLinkProvider {
  calls = 0;

  constructor(
    private readonly url = "https://emma.example.org/d/signed-token",
    private readonly shouldFail = false,
  ) {}

  async getOrCreateDigestAccessLink(): Promise<string> {
    this.calls += 1;
    if (this.shouldFail) throw new Error("database unavailable");
    return this.url;
  }
}

describe("Hosted Template sender safety", () => {
  it("sends TEST only to TEST_EMAIL with template variables and no rendered body", async () => {
    const store = new MemoryStore();
    const provider = new MockProvider();
    const accessLinks = new FixedAccessLinks();
    await sendDigest({ store, provider, accessLinks, config: testConfig(), digest: digest(), now });

    expect(store.status).toBe("SENT");
    expect(store.actualRecipientEmail).toBe("pawelekarcz@gmail.com");
    expect(provider.requests).toHaveLength(1);
    expect(accessLinks.calls).toBe(1);
    expect(provider.requests[0]?.template.variables.DETAIL_URL).toBe(
      "https://emma.example.org/d/signed-token",
    );
    expect(provider.requests[0]).toMatchObject({
      to: "pawelekarcz@gmail.com",
      subject: "[TEST] Emma: aktualizacja",
      template: {
        id: "medical-device-update",
        variables: { TEST_DISPLAY: "table-row" },
      },
    });
    const request = provider.requests[0] as unknown as Record<string, unknown>;
    expect(request).not.toHaveProperty("html");
    expect(request).not.toHaveProperty("text");
    expect(request).not.toHaveProperty("react");
    expect(request).not.toHaveProperty("cc");
    expect(request).not.toHaveProperty("bcc");
    expect(request).not.toHaveProperty("replyTo");
  });

  it("blocks PRODUCTION when production emails are not explicitly enabled", async () => {
    const store = new MemoryStore();
    const provider = new MockProvider();
    await sendDigest({
      store,
      provider,
      accessLinks: new FixedAccessLinks(),
      config: { ...testConfig(), mode: "PRODUCTION", productionEmailsEnabled: false },
      digest: digest(),
      now,
    });
    expect(provider.requests).toHaveLength(0);
    expect(store.lastError).toBe("PRODUCTION_EMAILS_BLOCKED");
  });

  it("blocks an AccessLink creation failure without calling Resend", async () => {
    const store = new MemoryStore();
    const provider = new MockProvider();
    await sendDigest({
      store,
      provider,
      accessLinks: new FixedAccessLinks("", true),
      config: testConfig(),
      digest: digest(),
      now,
    });
    expect(provider.requests).toHaveLength(0);
    expect(store.lastError).toBe("ACCESS_LINK_CREATION_FAILED");
    expect(store.nextRetryAt).toEqual(new Date(now.getTime() + 60_000));
  });

  it("keeps the same idempotency key on retry", async () => {
    const store = new MemoryStore();
    const provider = new MockProvider([
      { ok: false, error: { name: "rate_limit_exceeded", statusCode: 429 } },
      { ok: true, id: "resend-after-retry" },
    ]);
    const candidate = digest();
    const accessLinks = new FixedAccessLinks();
    await sendDigest({ store, provider, accessLinks, config: testConfig(), digest: candidate, now });
    candidate.status = "FAILED";
    candidate.nextRetryAt = store.nextRetryAt;
    await sendDigest({
      store,
      provider,
      accessLinks,
      config: testConfig(),
      digest: candidate,
      now: new Date(now.getTime() + 60_000),
    });
    expect(provider.requests.map((request) => request.idempotencyKey)).toEqual([
      "emma-digest/digest-1",
      "emma-digest/digest-1",
    ]);
    expect(idempotencyKey("digest-1")).toBe("emma-digest/digest-1");
  });

  it("uses the template default subject in enabled PRODUCTION mode", async () => {
    const provider = new MockProvider();
    await sendDigest({
      store: new MemoryStore(),
      provider,
      accessLinks: new FixedAccessLinks(),
      config: { ...testConfig(), mode: "PRODUCTION", productionEmailsEnabled: true },
      digest: digest(),
      now,
    });
    expect(provider.requests[0]?.to).toBe("client@example.com");
    expect(provider.requests[0]).not.toHaveProperty("subject");
  });

  it("stores a safe template-specific code for permanent rejection", async () => {
    const store = new MemoryStore();
    await sendDigest({
      store,
      provider: new MockProvider([{
        ok: false,
        error: { name: "validation_error", statusCode: 422 },
      }]),
      accessLinks: new FixedAccessLinks(),
      config: testConfig(),
      digest: digest(),
      now,
    });
    expect(store.lastError).toBe("RESEND_TEMPLATE_REJECTED");
    expect(store.nextRetryAt).toBeNull();
  });
});

function testConfig(): EmailSenderConfig {
  return {
    mode: "TEST",
    testEmail: "pawelekarcz@gmail.com",
    productionEmailsEnabled: false,
    resendApiKey: "re_test_mock",
    caseDigestTemplateId: "medical-device-update",
    emailFrom: "Emma <emma@example.com>",
  };
}

function digest(): DigestCandidate {
  return {
    id: "digest-1",
    type: "CASE_DIGEST",
    status: "CREATED",
    intendedRecipientEmail: "client@example.com",
    subject: "Emma: aktualizacja",
    itemsCount: 1,
    sendAttempts: 0,
    sendingStartedAt: null,
    nextRetryAt: null,
    items: [{
      trackedCaseId: "case-1",
      lastEventAt: new Date("2026-08-08T15:53:00.000Z"),
      snapshot: {
        caseType: "SERVICE_ORDER",
        businessNumber: "20905",
        currentStatus: "Naprawa zakończona",
        device: { name: "Aparat USG" },
      },
    }],
  };
}
