import { describe, expect, it, vi } from "vitest";
import {
  CommunicationDeliveryCancelReason,
  CommunicationDeliveryStatus,
  CommunicationRecipientType,
  CommunicationScenario,
} from "../generated/prisma/enums.js";
import type { EmailProvider, ProviderEmailRequest, ProviderEmailResult } from "../email/resend-client.js";
import {
  communicationIdempotencyKey,
  runCommunicationEmailSender,
  type CommunicationEmailSenderConfig,
  type CommunicationEmailSendStore,
  type CommunicationPortalGrantProvider,
  type CommunicationUnsubscribeGrantProvider,
  type CommunicationSendCandidate,
  type PersistedCommunicationSendSnapshot,
} from "./communication-email-sender.js";
import type { CommunicationTemplateDataSource } from "./communication-template-data.js";
import type { CommunicationAssetPreflight } from "../assets/preflight.js";

const now = new Date("2026-08-15T10:00:00Z");
const activation = new Date("2026-08-15T09:00:00Z");

describe("communication email activation and recipient safety", () => {
  it("does nothing when COMMUNICATION_EMAILS_ENABLED=false", async () => {
    const fixture = setup();
    const stats = await run(fixture, { communicationEmailsEnabled: false });
    expect(stats.candidates).toBe(0);
    expect(fixture.store.findCalls).toBe(0);
    expect(fixture.provider.requests).toHaveLength(0);
  });

  it("keeps asset discovery completely disabled by the default kill switch", async () => {
    const fixture = setup();
    const prepare = vi.fn();
    await run(fixture, {}, [], now, { prepare });
    expect(prepare).not.toHaveBeenCalled();
    expect(fixture.provider.requests).toHaveLength(1);
  });

  it("cancels a historical missing-scope delivery before claim and never revisits it", async () => {
    const fixture = setup({
      detectedAt: new Date(activation.getTime() - 1),
      eventSnapshot: {},
    });
    const prepare = vi.fn();
    for (let loop = 0; loop < 100; loop += 1) {
      await run(fixture, { communicationAssetsEnabled: true }, [], now, { prepare });
    }
    expect(fixture.candidate.status).toBe(CommunicationDeliveryStatus.CANCELLED);
    expect(fixture.store.cancelReason).toBe(
      CommunicationDeliveryCancelReason.MISSING_HOSPITAL_SCOPE_LEGACY,
    );
    expect(fixture.candidate.attemptCount).toBe(0);
    expect(fixture.provider.requests).toHaveLength(0);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("does not retry a FAILED missing-scope delivery even if nextRetryAt was set", async () => {
    const fixture = setup({
      status: CommunicationDeliveryStatus.FAILED,
      nextRetryAt: new Date(now.getTime() - 1),
      eventSnapshot: {},
    });
    await run(fixture);
    expect(fixture.candidate.status).toBe(CommunicationDeliveryStatus.CANCELLED);
    expect(fixture.store.cancelReason).toBe(
      CommunicationDeliveryCancelReason.MISSING_HOSPITAL_SCOPE,
    );
    expect(fixture.candidate.attemptCount).toBe(0);
  });

  it("runs bounded asset preflight before sending when explicitly enabled", async () => {
    const fixture = setup();
    const order: string[] = [];
    const prepare = vi.fn(async () => { order.push("assets"); });
    const originalSend = fixture.provider.send.bind(fixture.provider);
    fixture.provider.send = async (request) => { order.push("email"); return originalSend(request); };
    await run(fixture, { communicationAssetsEnabled: true }, [], now, { prepare });
    expect(order).toEqual(["assets", "email"]);
  });

  it("fails closed without valid SEND_NOT_BEFORE and does not crash", async () => {
    const fixture = setup();
    const logs: string[] = [];
    await run(fixture, { communicationSendNotBefore: null }, logs);
    expect(fixture.provider.requests).toHaveLength(0);
    expect(logs.join(" ")).toContain("COMMUNICATION_EMAIL_BARRIER_BLOCKED");
  });

  it("blocks PRODUCTION unless PRODUCTION_EMAILS_ENABLED is true", async () => {
    const fixture = setup();
    await run(fixture, { mode: "PRODUCTION", productionEmailsEnabled: false });
    expect(fixture.provider.requests).toHaveLength(0);
  });

  it("routes TEST mode only to TEST_EMAIL while preserving intended recipient", async () => {
    const fixture = setup();
    const intended = fixture.candidate.recipient.email;
    await run(fixture);
    expect(fixture.provider.requests[0]?.to).toBe("test@example.test");
    expect(fixture.candidate.recipient.email).toBe(intended);
    expect(fixture.store.actualRecipientEmail).toBe("test@example.test");
    expect(fixture.store.emailMode).toBe("TEST");
  });

  it("sends one new scoped REPAIR_COMPLETED only to TEST_EMAIL", async () => {
    const fixture = setup({
      scenario: CommunicationScenario.REPAIR_COMPLETED,
      eventSnapshot: {
        ...repairSnapshot(),
        emmaCustomerStatus: "Naprawa zakoĹ„czona",
      },
    });
    await run(fixture);
    expect(fixture.candidate.status).toBe(CommunicationDeliveryStatus.SENT);
    expect(fixture.provider.requests).toHaveLength(1);
    expect(fixture.provider.requests[0]?.to).toBe("test@example.test");
    expect(fixture.store.actualRecipientEmail).toBe("test@example.test");
  });

  it("uses published hosted template and replyTo without from/subject/html/text/react", async () => {
    const fixture = setup();
    await run(fixture);
    const request = fixture.provider.requests[0]!;
    expect(request).not.toHaveProperty("from");
    expect(request).not.toHaveProperty("subject");
    expect(request.replyTo).toBe("serwis@tiemed.pl");
    expect(request.template.id).toBe("emma-repair-received");
    expect(request as unknown as Record<string, unknown>).not.toHaveProperty("html");
    expect(request as unknown as Record<string, unknown>).not.toHaveProperty("text");
    expect(request as unknown as Record<string, unknown>).not.toHaveProperty("react");
  });
});

describe("activation cutoff", () => {
  it("cancels old event-driven delivery as PRE_ACTIVATION", async () => {
    const fixture = setup({ detectedAt: new Date(activation.getTime() - 1) });
    await run(fixture);
    expect(fixture.candidate.status).toBe(CommunicationDeliveryStatus.CANCELLED);
    expect(fixture.store.cancelReason).toBe(CommunicationDeliveryCancelReason.PRE_ACTIVATION);
    expect(fixture.provider.requests).toHaveLength(0);
  });

  it("sends event-driven delivery detected at activation", async () => {
    const fixture = setup({ detectedAt: activation });
    await run(fixture);
    expect(fixture.candidate.status).toBe(CommunicationDeliveryStatus.SENT);
  });

  it("allows future reminder scheduled after activation even if event is older", async () => {
    const fixture = setup({
      scenario: CommunicationScenario.INSPECTION_REMINDER,
      detectedAt: new Date(activation.getTime() - 86_400_000),
      scheduledFor: new Date(activation.getTime() + 1),
      eventSnapshot: reminderSnapshot(),
    });
    await run(fixture);
    expect(fixture.candidate.status).toBe(CommunicationDeliveryStatus.SENT);
  });
});

describe("final reminder validation", () => {
  it("cancels reminder changed after READY and before send", async () => {
    const fixture = setup({
      scenario: CommunicationScenario.INSPECTION_REMINDER,
      scheduledFor: activation,
      eventSnapshot: reminderSnapshot(),
    });
    fixture.store.currentTask = { ...currentTask(), day: "2026-08-20" };
    await run(fixture);
    expect(fixture.store.cancelReason).toBe(
      CommunicationDeliveryCancelReason.SOURCE_STATE_CHANGED,
    );
    expect(fixture.provider.requests).toHaveLength(0);
    expect(fixture.grants.calls).toBe(0);
  });

  it("cancels reminder when visit day has arrived", async () => {
    const fixture = setup({
      scenario: CommunicationScenario.INSPECTION_REMINDER,
      scheduledFor: activation,
      eventSnapshot: reminderSnapshot({ day: "2026-08-15" }),
    });
    fixture.store.currentTask = currentTask({ day: "2026-08-15" });
    await run(fixture);
    expect(fixture.store.cancelReason).toBe(
      CommunicationDeliveryCancelReason.REMINDER_EXPIRED,
    );
  });
});

describe("claim, JIT grant and deterministic retry", () => {
  it("normalizes a legacy numeric-string DEVICE_COUNT before the Resend request", async () => {
    const fixture = setup({
      scenario: CommunicationScenario.INSPECTION_DATE_CONFIRMED,
      eventSnapshot: {
        ...reminderSnapshot(),
        linkedInspectionRecordIds: Array.from({ length: 15 }, (_, index) => `inspection-${index}`),
      },
      sendSnapshot: {
        templateId: "emma-inspection-confirmed",
        variables: {
          SERVICE_NAME: "Tiemed",
          SENT_AT: "15.08.2026, 12:00",
          VISIT_DATE: "21.08.2026",
          DEPARTMENT: "Serwis",
          DEVICE_COUNT: "15",
          DEVICES_ROWS: "<tr></tr>",
        },
        portalGrantPublicId: "grant-public-id",
        unsubscribeGrantPublicId: "unsubscribe-public-id",
        preparedAt: now.toISOString(),
      },
    });
    await run(fixture);
    const variables = fixture.provider.requests[0]!.template.variables;
    expect(typeof variables.DEVICE_COUNT).toBe("number");
    expect(variables.DEVICE_COUNT).toBe(15);
  });

  it("does not call Resend when DEVICE_COUNT is not a finite number", async () => {
    const fixture = setup({
      scenario: CommunicationScenario.INSPECTION_DATE_CONFIRMED,
      eventSnapshot: reminderSnapshot(),
      sendSnapshot: {
        templateId: "emma-inspection-confirmed",
        variables: { DEVICE_COUNT: "not-a-number" },
        portalGrantPublicId: "grant-public-id",
        unsubscribeGrantPublicId: "unsubscribe-public-id",
        preparedAt: now.toISOString(),
      },
    });
    await run(fixture);
    expect(fixture.provider.requests).toHaveLength(0);
    expect(fixture.store.lastError).toBe("TEMPLATE_VARIABLES_INVALID");
  });

  it("preserves exact Unicode through builder, sendSnapshot and Resend request", async () => {
    const expected = ["Damian · Tiemed", "Michał Kowalski", "Urządzenie", "Przegląd", "Oczekiwanie na części", "Łódź", "Żółty", "Nr zlecenia klienta"];
    for (const value of expected) {
      const fixture = setup({ eventSnapshot: {
        businessNumber: "SO-1", sourceHospitalRecordId: "recHospital",
        sourceCreatedAt: "2026-08-15T08:00:00Z",
        device: { name: value },
      } });
      await run(fixture);
      expect(fixture.provider.requests[0]!.template.variables.DEVICE_NAME).toBe(value);
      expect(fixture.candidate.sendSnapshot?.variables.DEVICE_NAME).toBe(value);
      expect(JSON.stringify(fixture.candidate.sendSnapshot)).not.toContain("Ă‚Â·");
    }
  });

  it("two concurrent sender loops make one provider request", async () => {
    const fixture = setup();
    await Promise.all([run(fixture), run(fixture)]);
    expect(fixture.provider.requests).toHaveLength(1);
  });

  it("first preparation creates one portal grant", async () => {
    const fixture = setup();
    await run(fixture);
    expect(fixture.grants.calls).toBe(1);
  });

  it("429 retry keeps identical grant, URL, idempotency key and sendSnapshot", async () => {
    const fixture = setup({}, [
      { ok: false, error: { name: "rate_limit_exceeded", statusCode: 429 } },
      { ok: true, id: "resend-after-retry" },
    ]);
    await run(fixture);
    const firstSnapshot = structuredClone(fixture.candidate.sendSnapshot);
    const firstRequest = structuredClone(fixture.provider.requests[0]);
    await run(fixture, {}, [], new Date(now.getTime() + 60_000));
    expect(fixture.grants.publicIds).toEqual(["grant-public-id", "grant-public-id"]);
    expect(fixture.unsubscribeGrants.publicIds).toEqual(["unsubscribe-public-id", "unsubscribe-public-id"]);
    expect(fixture.candidate.sendSnapshot).toEqual(firstSnapshot);
    expect(fixture.provider.requests[1]).toEqual(firstRequest);
    expect(fixture.provider.requests.map((request) => request.idempotencyKey))
      .toEqual(["emma-communication/delivery-1", "emma-communication/delivery-1"]);
  });

  it("stable idempotency key is derived only from delivery ID", () => {
    expect(communicationIdempotencyKey("delivery-1"))
      .toBe("emma-communication/delivery-1");
  });

  it("SENT delivery is never selected or sent again", async () => {
    const fixture = setup();
    await run(fixture);
    await run(fixture);
    expect(fixture.provider.requests).toHaveLength(1);
  });
});

describe("provider result and retry classification", () => {
  it("success persists SENT, message ID, sentAt and attempt count", async () => {
    const fixture = setup();
    await run(fixture);
    expect(fixture.candidate.status).toBe(CommunicationDeliveryStatus.SENT);
    expect(fixture.store.resendMessageId).toBe("resend-1");
    expect(fixture.store.sentAt).toEqual(now);
    expect(fixture.candidate.attemptCount).toBe(1);
  });

  it.each([
    { name: "rate_limit_exceeded", statusCode: 429 },
    { name: "internal_server_error", statusCode: 503 },
  ])("schedules retry for transient $statusCode response", async (error) => {
    const fixture = setup({}, [{ ok: false, error }]);
    await run(fixture);
    expect(fixture.candidate.status).toBe(CommunicationDeliveryStatus.FAILED);
    expect(fixture.candidate.nextRetryAt).toEqual(new Date(now.getTime() + 60_000));
  });

  it("marks permanent provider validation rejection without retry", async () => {
    const fixture = setup({}, [{
      ok: false,
      error: { name: "validation_error", statusCode: 422 },
    }]);
    await run(fixture);
    expect(fixture.store.lastError).toBe("RESEND_REQUEST_REJECTED");
    expect(fixture.candidate.nextRetryAt).toBeNull();
  });

  it("keeps fallback content identical to client content", async () => {
    const client = setup();
    const fallback = setup({ recipientType: CommunicationRecipientType.TIEMED_FALLBACK });
    await run(client);
    await run(fallback);
    expect(fallback.provider.requests[0]?.template).toEqual(client.provider.requests[0]?.template);
  });
});

class MemorySendStore implements CommunicationEmailSendStore {
  findCalls = 0;
  currentTask = currentTask();
  actualRecipientEmail: string | null = null;
  emailMode: string | null = null;
  cancelReason: CommunicationDeliveryCancelReason | null = null;
  resendMessageId: string | null = null;
  sentAt: Date | null = null;
  lastError: string | null = null;
  constructor(readonly candidate: CommunicationSendCandidate) {}

  async findCandidates(at: Date) {
    this.findCalls += 1;
    if (this.candidate.status === CommunicationDeliveryStatus.READY ||
      this.candidate.status === CommunicationDeliveryStatus.FAILED &&
      this.candidate.nextRetryAt && this.candidate.nextRetryAt <= at) return [this.candidate];
    return [];
  }
  async claim(candidate: CommunicationSendCandidate, _at: Date, mode: string, actual: string) {
    if (candidate.status !== CommunicationDeliveryStatus.READY &&
      candidate.status !== CommunicationDeliveryStatus.FAILED) return false;
    candidate.status = CommunicationDeliveryStatus.SENDING;
    candidate.attemptCount += 1;
    candidate.nextRetryAt = null;
    this.emailMode = mode;
    this.actualRecipientEmail = actual;
    return true;
  }
  async getCurrentTask() { return this.currentTask; }
  async saveSnapshot(
    _id: string,
    snapshot: PersistedCommunicationSendSnapshot,
  ) {
    this.candidate.sendSnapshot ??= snapshot;
    return this.candidate.sendSnapshot;
  }
  async markSent(_id: string, messageId: string, at: Date) {
    this.candidate.status = CommunicationDeliveryStatus.SENT;
    this.resendMessageId = messageId;
    this.sentAt = at;
  }
  async markFailed(_id: string, reason: string, _at: Date, next: Date | null) {
    this.candidate.status = CommunicationDeliveryStatus.FAILED;
    this.candidate.nextRetryAt = next;
    this.lastError = reason;
  }
  async cancel(_id: string, reason: CommunicationDeliveryCancelReason) {
    this.candidate.status = CommunicationDeliveryStatus.CANCELLED;
    this.cancelReason = reason;
    return true;
  }
}

class MockProvider implements EmailProvider {
  requests: ProviderEmailRequest[] = [];
  constructor(private readonly results: ProviderEmailResult[]) {}
  async send(request: ProviderEmailRequest) {
    this.requests.push(structuredClone(request));
    return this.results.shift() ?? { ok: true as const, id: "resend-1" };
  }
}

class FixedGrants implements CommunicationPortalGrantProvider {
  calls = 0;
  publicIds: string[] = [];
  async getOrCreatePortalAccessGrant(deliveryId: string) {
    this.calls += 1;
    this.publicIds.push("grant-public-id");
    return {
      grant: {
        publicId: "grant-public-id",
        communicationDeliveryId: deliveryId,
        sourceHospitalRecordId: "recHospital",
        entryContext: {
          type: "SERVICE_ORDER" as const,
          sourceRecordId: "recService",
          scenario: CommunicationScenario.REPAIR_RECEIVED,
        },
        expiresAt: new Date(now.getTime() + 30 * 86_400_000),
        createdAt: now,
      },
      url: "https://notify.example.org/p/stable-token",
    };
  }
}

class FixedUnsubscribeGrants implements CommunicationUnsubscribeGrantProvider {
  calls = 0;
  publicIds: string[] = [];
  async getOrCreateUnsubscribeGrant(deliveryId: string) {
    this.calls += 1;
    this.publicIds.push("unsubscribe-public-id");
    return {
      grant: {
        publicId: "unsubscribe-public-id", communicationDeliveryId: deliveryId,
        sourceHospitalRecordId: "recHospital", normalizedEmail: "client@example.com",
        canOptOut: true, expiresAt: new Date(now.getTime() + 30 * 86_400_000), createdAt: now,
      },
      url: "https://notify.example.org/u/stable-token",
    };
  }
}

function setup(
  overrides: Partial<CommunicationSendCandidate> & {
    detectedAt?: Date;
    eventSnapshot?: unknown;
    recipientType?: CommunicationRecipientType;
  } = {},
  results: ProviderEmailResult[] = [{ ok: true, id: "resend-1" }],
) {
  const candidate = communicationCandidate(overrides);
  return {
    candidate,
    store: new MemorySendStore(candidate),
    provider: new MockProvider(results),
    grants: new FixedGrants(),
    unsubscribeGrants: new FixedUnsubscribeGrants(),
    dataSource: dataSource(),
  };
}

function run(
  fixture: ReturnType<typeof setup>,
  configOverrides: Partial<CommunicationEmailSenderConfig> = {},
  logs: string[] = [],
  at = now,
  assetPreflight?: CommunicationAssetPreflight,
) {
  return runCommunicationEmailSender({
    store: fixture.store,
    provider: fixture.provider,
    grants: fixture.grants,
    unsubscribeGrants: fixture.unsubscribeGrants,
    dataSource: fixture.dataSource,
    ...(assetPreflight ? { assetPreflight } : {}),
    config: { ...config(), ...configOverrides },
    now: () => at,
    log: (message) => logs.push(message),
  });
}

function config(): CommunicationEmailSenderConfig {
  return {
    communicationEmailsEnabled: true,
    communicationSendNotBefore: activation,
    mode: "TEST",
    testEmail: "test@example.test",
    productionEmailsEnabled: false,
    resendApiKey: "re_test_mock",
    replyTo: "serwis@tiemed.pl",
    timeZone: "Europe/Warsaw",
  };
}

function communicationCandidate(
  overrides: Partial<CommunicationSendCandidate> & {
    detectedAt?: Date;
    eventSnapshot?: unknown;
    recipientType?: CommunicationRecipientType;
  } = {},
): CommunicationSendCandidate {
  const detectedAt = overrides.detectedAt ?? activation;
  const eventSnapshot = overrides.eventSnapshot ?? repairSnapshot();
  const recipientType = overrides.recipientType ?? CommunicationRecipientType.CLIENT;
  return {
    id: "delivery-1",
    status: CommunicationDeliveryStatus.READY,
    scenario: CommunicationScenario.REPAIR_RECEIVED,
    scheduledFor: activation,
    attemptCount: 0,
    sendingStartedAt: null,
    nextRetryAt: null,
    sendSnapshot: null,
    event: { detectedAt, sourceRecordId: "recService", eventSnapshot },
    recipient: { recipientType, email: "client@example.com", normalizedEmail: "client@example.com" },
    ...overrides,
  };
}

function repairSnapshot() {
  return {
    businessNumber: "SO-1",
    clientOrderNumber: null,
    emmaCustomerStatus: "Przyjęto",
    sourceHospitalRecordId: "recHospital",
    sourceCreatedAt: "2026-08-15T08:00:00Z",
    device: {
      name: "USG", manufacturer: "Philips", model: "Epiq",
      serialNumber: "SN-1", inventoryNumber: null,
    },
  };
}

function reminderSnapshot(overrides = {}) {
  return {
    sourceHospitalRecordId: "recHospital",
    day: "2026-08-16",
    emmaCustomerStatus: "Wizyta potwierdzona",
    emmaMailTemplate: "Przegląd-przypomnienie_o_wizycie",
    completed: false,
    performerRecordIds: [],
    linkedInspectionRecordIds: ["inspectionA"],
    ...overrides,
  };
}

function currentTask(overrides = {}) {
  return {
    day: "2026-08-16",
    emmaCustomerStatus: "Wizyta potwierdzona",
    emmaMailTemplate: "Przegląd-przypomnienie_o_wizycie",
    completed: false,
    ...overrides,
  };
}

function dataSource(): CommunicationTemplateDataSource {
  return {
    async getEmployees() { return []; },
    async getInspections() { return []; },
  };
}
