import { describe, expect, it } from "vitest";
import {
  idempotencyKey,
  sendDigest,
  type DigestCandidate,
  type DigestSendStore,
  type EmailSenderConfig,
} from "./sender.js";
import type {
  EmailProvider,
  ProviderEmailRequest,
  ProviderEmailResult,
} from "./resend-client.js";

const now = new Date("2026-08-08T18:00:00.000Z");

class MemoryStore implements DigestSendStore {
  status: string = "CREATED";
  actualRecipientEmail: string | null = null;
  sendAttempts = 0;
  resendEmailId: string | null = null;
  sentAt: Date | null = null;
  failedAt: Date | null = null;
  lastError: string | null = null;
  nextRetryAt: Date | null = null;

  async findCandidates(): Promise<DigestCandidate[]> {
    return [];
  }

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

  async markSent(
    _digestId: string,
    resendEmailId: string,
    sentAt: Date,
  ): Promise<void> {
    this.status = "SENT";
    this.resendEmailId = resendEmailId;
    this.sentAt = sentAt;
    this.lastError = null;
  }

  async markFailed(
    _digestId: string,
    code: string,
    failedAt: Date,
    nextRetryAt: Date | null,
  ): Promise<void> {
    this.status = "FAILED";
    this.failedAt = failedAt;
    this.lastError = code;
    this.nextRetryAt = nextRetryAt;
  }
}

class MockProvider implements EmailProvider {
  readonly requests: ProviderEmailRequest[] = [];

  constructor(
    private readonly results: ProviderEmailResult[] = [
      { ok: true, id: "resend-1" },
    ],
  ) {}

  async send(request: ProviderEmailRequest): Promise<ProviderEmailResult> {
    this.requests.push(request);
    return this.results.shift() ?? { ok: true, id: "resend-fallback" };
  }
}

describe("email recipient safety", () => {
  it("uses only TEST_EMAIL in transport headers in TEST mode", async () => {
    const store = new MemoryStore();
    const provider = new MockProvider();
    await sendDigest({
      store,
      provider,
      config: testConfig(),
      digest: digest(),
      now,
    });

    expect(store.status).toBe("SENT");
    expect(store.actualRecipientEmail).toBe("pawelekarcz@gmail.com");
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]).toMatchObject({
      to: "pawelekarcz@gmail.com",
      subject: "[TEST] Emma: aktualizacja",
    });
    const request = provider.requests[0] as unknown as Record<string, unknown>;
    expect(request.to).not.toBe("client@example.com");
    expect(request).not.toHaveProperty("cc");
    expect(request).not.toHaveProperty("bcc");
    expect(request).not.toHaveProperty("replyTo");
  });

  it("blocks PRODUCTION when the explicit production switch is false", async () => {
    const store = new MemoryStore();
    const provider = new MockProvider();
    await sendDigest({
      store,
      provider,
      config: { ...testConfig(), mode: "PRODUCTION", productionEmailsEnabled: false },
      digest: digest(),
      now,
    });

    expect(provider.requests).toHaveLength(0);
    expect(store.status).toBe("FAILED");
    expect(store.lastError).toBe("PRODUCTION_EMAILS_BLOCKED");
    expect(store.nextRetryAt).toBeNull();
  });

  it("does not call Resend when EMAIL_FROM is missing", async () => {
    const store = new MemoryStore();
    const provider = new MockProvider();
    await sendDigest({
      store,
      provider,
      config: { ...testConfig(), emailFrom: null },
      digest: digest(),
      now,
    });

    expect(provider.requests).toHaveLength(0);
    expect(store.lastError).toBe("EMAIL_FROM_MISSING");
    expect(store.nextRetryAt).toBeNull();
  });

  it("uses intended recipient in explicitly enabled PRODUCTION mode", async () => {
    const store = new MemoryStore();
    const provider = new MockProvider();
    await sendDigest({
      store,
      provider,
      config: { ...testConfig(), mode: "PRODUCTION", productionEmailsEnabled: true },
      digest: digest(),
      now,
    });

    expect(provider.requests[0]?.to).toBe("client@example.com");
    expect(provider.requests[0]?.subject).toBe("Emma: aktualizacja");
  });
});

describe("email sending", () => {
  it("uses the same idempotency key for a retry of the same digest", async () => {
    const store = new MemoryStore();
    const provider = new MockProvider([
      {
        ok: false,
        error: { name: "rate_limit_exceeded", statusCode: 429 },
      },
      { ok: true, id: "resend-after-retry" },
    ]);
    const candidate = digest();
    await sendDigest({ store, provider, config: testConfig(), digest: candidate, now });
    candidate.status = "FAILED";
    candidate.nextRetryAt = store.nextRetryAt;
    await sendDigest({
      store,
      provider,
      config: testConfig(),
      digest: candidate,
      now: new Date(now.getTime() + 60_000),
    });

    expect(provider.requests.map((request) => request.idempotencyKey)).toEqual([
      "emma-digest/digest-1",
      "emma-digest/digest-1",
    ]);
    expect(idempotencyKey("digest-1")).toBe("emma-digest/digest-1");
    expect(store.status).toBe("SENT");
    expect(store.sendAttempts).toBe(2);
  });

  it("sends one request containing all three digest items in HTML and text", async () => {
    const store = new MemoryStore();
    const provider = new MockProvider();
    const candidate = digest();
    candidate.items = [item("100"), item("200"), item("300")];
    candidate.itemsCount = 3;
    await sendDigest({ store, provider, config: testConfig(), digest: candidate, now });

    expect(provider.requests).toHaveLength(1);
    for (const number of ["100", "200", "300"]) {
      expect(provider.requests[0]?.html).toContain(number);
      expect(provider.requests[0]?.text).toContain(number);
    }
  });

  it("omits null and undefined optional fields", async () => {
    const store = new MemoryStore();
    const provider = new MockProvider();
    const candidate = digest();
    candidate.items = [{
      snapshot: {
        caseType: "SERVICE_ORDER",
        businessNumber: "20905",
        currentStatus: "Naprawa zakończona",
        faultDescription: null,
        device: { name: "Aparat USG", model: null, serialNumber: undefined },
      },
      changes: [],
    }];
    await sendDigest({ store, provider, config: testConfig(), digest: candidate, now });

    expect(provider.requests[0]?.html).not.toMatch(/Model: null|SN: undefined|Usterka:/);
    expect(provider.requests[0]?.text).not.toMatch(/Model: null|SN: undefined|Usterka:/);
  });

  it("moves CREATED through SENDING to SENT and stores provider metadata", async () => {
    const store = new MemoryStore();
    await sendDigest({
      store,
      provider: new MockProvider([{ ok: true, id: "resend-success" }]),
      config: testConfig(),
      digest: digest(),
      now,
    });
    expect(store.status).toBe("SENT");
    expect(store.resendEmailId).toBe("resend-success");
    expect(store.sentAt).toEqual(now);
    expect(store.sendAttempts).toBe(1);
  });

  it("retries transient failures but not permanent failures or a third failure", async () => {
    const transientStore = new MemoryStore();
    await sendDigest({
      store: transientStore,
      provider: new MockProvider([{ ok: false, error: { name: "internal_server_error", statusCode: 500 } }]),
      config: testConfig(),
      digest: digest(),
      now,
    });
    expect(transientStore.lastError).toBe("RESEND_TRANSIENT_ERROR");
    expect(transientStore.nextRetryAt).toEqual(new Date(now.getTime() + 60_000));

    const permanentStore = new MemoryStore();
    await sendDigest({
      store: permanentStore,
      provider: new MockProvider([{ ok: false, error: { name: "validation_error", statusCode: 422 } }]),
      config: testConfig(),
      digest: digest(),
      now,
    });
    expect(permanentStore.lastError).toBe("RESEND_REQUEST_REJECTED");
    expect(permanentStore.nextRetryAt).toBeNull();

    const exhaustedStore = new MemoryStore();
    exhaustedStore.sendAttempts = 2;
    const thirdAttempt = digest();
    thirdAttempt.sendAttempts = 2;
    thirdAttempt.status = "FAILED";
    await sendDigest({
      store: exhaustedStore,
      provider: new MockProvider([{ ok: false, error: { name: "internal_server_error", statusCode: 503 } }]),
      config: testConfig(),
      digest: thirdAttempt,
      now,
    });
    expect(exhaustedStore.sendAttempts).toBe(3);
    expect(exhaustedStore.nextRetryAt).toBeNull();
  });
});

function testConfig(): EmailSenderConfig {
  return {
    mode: "TEST",
    testEmail: "pawelekarcz@gmail.com",
    productionEmailsEnabled: false,
    resendApiKey: "re_test_mock",
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
    items: [item("20905")],
  };
}

function item(businessNumber: string) {
  return {
    snapshot: {
      caseType: "SERVICE_ORDER",
      businessNumber,
      currentStatus: "Naprawa zakończona",
      faultDescription: "Brak obrazu",
      device: {
        name: "Aparat USG",
        manufacturer: "Philips",
        model: "Affiniti 50",
      },
    },
    changes: [{
      fieldName: "STATUS",
      oldValue: "Naprawa w toku",
      newValue: "Naprawa zakończona",
    }],
  };
}
