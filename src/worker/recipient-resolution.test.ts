import { describe, expect, it, vi } from "vitest";
import {
  CommunicationRecipientResolutionStatus,
  CommunicationRecipientType,
  CommunicationScenario,
  CommunicationSourceEntityType,
} from "../generated/prisma/enums.js";
import { CONTACT_FIELDS } from "../airtable/field-ids.js";
import type { AirtableIncrementalSource, AirtableRecord } from "../airtable/types.js";
import {
  recipientResolutionBackoffSeconds,
  resolveCommunicationEventRecipients,
  resolvePendingCommunicationRecipients,
  type CommunicationEventRecipientInput,
  type RecipientResolutionEvent,
  type RecipientResolutionStore,
} from "./recipient-resolution.js";

const fallbackEmail = "fallback@example.test";

describe("TASK recipient resolution", () => {
  it("resolves one selected contact as one CLIENT recipient", async () => {
    const result = await resolveTask(["recA"], { recA: contact("recA", "a@x.pl") });
    expect(ready(result.store)).toMatchObject([
      { recipientType: CommunicationRecipientType.CLIENT, normalizedEmail: "a@x.pl" },
    ]);
  });

  it("resolves three different selected contacts separately", async () => {
    const result = await resolveTask(["recA", "recB", "recC"], {
      recA: contact("recA", "a@x.pl"),
      recB: contact("recB", "b@x.pl"),
      recC: contact("recC", "c@x.pl"),
    });
    expect(ready(result.store)).toHaveLength(3);
  });

  it("deduplicates contacts by trimmed, lowercase normalizedEmail", async () => {
    const result = await resolveTask(["recA", "recB"], {
      recA: contact("recA", " Same@Example.PL "),
      recB: contact("recB", "same@example.pl"),
    });
    expect(ready(result.store)).toHaveLength(1);
    expect(ready(result.store)[0]?.normalizedEmail).toBe("same@example.pl");
  });

  it("keeps a valid client, records invalid diagnostics and does not add fallback", async () => {
    const result = await resolveTask(["recA", "recB"], {
      recA: contact("recA", "valid@example.pl"),
      recB: contact("recB", "invalid"),
    });
    expect(ready(result.store)).toHaveLength(1);
    expect(fallback(result.store)).toHaveLength(0);
    expect(invalid(result.store)).toHaveLength(1);
  });

  it("uses fallback when selected contacts are empty", async () => {
    const result = await resolveTask([], {});
    expect(fallback(result.store)).toHaveLength(1);
    expect(result.airtable.fetchRecord).not.toHaveBeenCalled();
  });

  it("uses fallback when every selected contact has no email", async () => {
    const result = await resolveTask(["recA", "recB"], {
      recA: contact("recA", null), recB: contact("recB", null),
    });
    expect(fallback(result.store)).toHaveLength(1);
  });

  it("uses fallback when every selected contact email is invalid", async () => {
    const result = await resolveTask(["recA", "recB"], {
      recA: contact("recA", "bad"), recB: contact("recB", "also-bad"),
    });
    expect(fallback(result.store)).toHaveLength(1);
  });

  it("uses the Contact Email field, never an event lookup value", async () => {
    const result = await resolveTask(["recA"], { recA: contact("recA", "fresh@x.pl") }, {
      selectedContactEmailLookup: "stale@x.pl",
    });
    expect(ready(result.store)[0]?.normalizedEmail).toBe("fresh@x.pl");
  });
});

describe("SERVICE_ORDER recipient resolution", () => {
  it("resolves one assigned contact as CLIENT", async () => {
    const result = await resolveService(["recA"], { recA: contact("recA", "a@x.pl") });
    expect(ready(result.store)).toHaveLength(1);
  });

  it("preserves multiple valid assigned contacts", async () => {
    const result = await resolveService(["recA", "recB"], {
      recA: contact("recA", "a@x.pl"), recB: contact("recB", "b@x.pl"),
    });
    expect(ready(result.store)).toHaveLength(2);
  });

  it("uses fallback when no assigned contact has a valid email", async () => {
    const result = await resolveService(["recA"], { recA: contact("recA", null) });
    expect(fallback(result.store)).toHaveLength(1);
  });
});

describe("fallback and failures", () => {
  it("does not create CLIENT or fallback when every valid client opted out", async () => {
    const store = new MemoryStore();
    store.optedOut.add("recHospital:a@x.pl");
    await resolveCommunicationEventRecipients({
      event: taskEvent(["recA"], { sourceHospitalRecordId: "recHospital" }),
      airtable: airtableSource({ recA: contact("recA", "a@x.pl") }),
      store,
      tiemedFallbackEmail: fallbackEmail,
    });
    expect(ready(store)).toHaveLength(0);
    expect(fallback(store)).toHaveLength(0);
    expect(invalid(store)).toMatchObject([{ resolutionReason: "OPTED_OUT" }]);
  });

  it("never adds fallback when at least one CLIENT is ready", async () => {
    const result = await resolveTask(["recA"], { recA: contact("recA", "a@x.pl") });
    expect(fallback(result.store)).toHaveLength(0);
  });

  it("persists FAILED and does not throw when fallback configuration is missing", async () => {
    const result = await resolveTask([], {}, {}, null);
    expect(result.store.failedReason).toBe("FALLBACK_MISSING");
    expect(result.logs.join(" ")).toContain("COMMUNICATION_RECIPIENT_FALLBACK_MISSING");
  });

  it("persists FAILED and never falls back on an Airtable read error", async () => {
    const store = new MemoryStore();
    const logs: string[] = [];
    const airtable = airtableSource({}, new Error("temporary"));
    await resolveCommunicationEventRecipients({
      event: taskEvent(["recA"]), airtable, store,
      tiemedFallbackEmail: fallbackEmail, log: (message) => logs.push(message),
    });
    expect(store.failedReason).toBe("AIRTABLE_CONTACT_READ_FAILED");
    expect(fallback(store)).toHaveLength(0);
    expect(logs.join(" ")).toContain("COMMUNICATION_RECIPIENT_RESOLUTION_FAILED");
  });

  it("logs operational metadata without email addresses or contact payloads", async () => {
    const result = await resolveTask(["recA"], { recA: contact("recA", "secret@x.pl") });
    expect(result.logs.join(" ")).toMatch(/eventId=evtTask.*recipientCount=1.*fallback=false/);
    expect(result.logs.join(" ")).not.toContain("secret@x.pl");
    expect(result.logs.join(" ")).not.toContain("Contact A");
  });
});

describe("recipient resolution idempotency and safety", () => {
  it("a repeated resolution keeps one recipient without duplicates", async () => {
    const store = new MemoryStore();
    const airtable = airtableSource({ recA: contact("recA", "a@x.pl") });
    const input = { event: taskEvent(["recA"]), airtable, store, tiemedFallbackEmail: fallbackEmail };
    await resolveCommunicationEventRecipients(input);
    await resolveCommunicationEventRecipients(input);
    expect(ready(store)).toHaveLength(1);
  });

  it("100 runs keep exactly the same recipient set", async () => {
    const store = new MemoryStore();
    const airtable = airtableSource({
      recA: contact("recA", "a@x.pl"), recB: contact("recB", "b@x.pl"),
    });
    const input = { event: taskEvent(["recA", "recB"]), airtable, store, tiemedFallbackEmail: fallbackEmail };
    for (let run = 0; run < 100; run += 1) await resolveCommunicationEventRecipients(input);
    expect(ready(store).map((item) => item.normalizedEmail).sort()).toEqual(["a@x.pl", "b@x.pl"]);
  });

  it("stops at recipient persistence without buffer, digest, AccessLink or Resend dependencies", async () => {
    const forbidden = vi.fn();
    const result = await resolveTask([], {});
    expect(result.store.recipients).toHaveLength(1);
    expect(forbidden).not.toHaveBeenCalled();
  });

  it("does not reactivate legacy CaseEvent mailing", async () => {
    const result = await resolveTask([], {});
    expect(result.store.resolvedAt).toBeInstanceOf(Date);
    expect(result.store.processedAtWrites).toBe(0);
  });
});

describe("recipient resolution retry", () => {
  it("backs off after Airtable failure and resolves when the retry succeeds", async () => {
    const store = new RetryStore();
    let calls = 0;
    const airtable = {
      fetchAllRecords: vi.fn(async () => []),
      fetchRecord: vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new Error("temporary failure");
        return contact("recA", "recovered@example.pl");
      }),
    } satisfies AirtableIncrementalSource;
    let clock = new Date("2026-08-13T10:00:00Z");
    const run = () => resolvePendingCommunicationRecipients({
      airtable, store, tiemedFallbackEmail: fallbackEmail, now: () => clock,
    });

    await run();
    expect(store.resolvedAt).toBeNull();
    expect(store.nextAt?.toISOString()).toBe("2026-08-13T10:00:15.000Z");
    clock = new Date("2026-08-13T10:00:14Z");
    expect(await run()).toBe(0);
    expect(calls).toBe(1);
    clock = new Date("2026-08-13T10:00:15Z");
    expect(await run()).toBe(1);
    expect(store.resolvedAt).toEqual(clock);
    expect(store.recipients[0]?.resolutionStatus).toBe(
      CommunicationRecipientResolutionStatus.READY,
    );
  });

  it("uses exponential backoff capped at 15 minutes", () => {
    expect(recipientResolutionBackoffSeconds(1)).toBe(15);
    expect(recipientResolutionBackoffSeconds(2)).toBe(30);
    expect(recipientResolutionBackoffSeconds(100)).toBe(900);
  });
});

class MemoryStore implements RecipientResolutionStore {
  recipients: CommunicationEventRecipientInput[] = [];
  resolvedAt: Date | null = null;
  failedReason: string | null = null;
  processedAtWrites = 0;
  optedOut = new Set<string>();
  async isOptedOut(hospital: string, email: string) { return this.optedOut.has(`${hospital}:${email}`); }
  async findUnresolved(): Promise<RecipientResolutionEvent[]> { return []; }
  async markResolved(_eventId: string, recipients: readonly CommunicationEventRecipientInput[], at: Date) {
    if (this.resolvedAt) return;
    this.recipients = [...recipients];
    this.resolvedAt = at;
  }
  async markFailed(
    _eventId: string,
    recipientType: CommunicationRecipientType,
    sourceContactRecordId: string | null,
    reason: string,
    _failedAt: Date,
  ) {
    this.recipients = [{
      recipientType, sourceContactRecordId, email: null, normalizedEmail: null,
      recipientKey: `FAILED:${reason}`, resolutionStatus: CommunicationRecipientResolutionStatus.FAILED,
      resolutionReason: reason,
    }];
    this.failedReason = reason;
  }
}

class RetryStore extends MemoryStore {
  nextAt: Date | null = null;
  attempts = 0;

  override async findUnresolved(now: Date): Promise<RecipientResolutionEvent[]> {
    if (this.resolvedAt || (this.nextAt && this.nextAt.getTime() > now.getTime())) return [];
    return [taskEvent(["recA"])];
  }

  override async markFailed(
    eventId: string,
    recipientType: CommunicationRecipientType,
    sourceContactRecordId: string | null,
    reason: string,
    failedAt: Date,
  ) {
    await super.markFailed(eventId, recipientType, sourceContactRecordId, reason, failedAt);
    this.attempts += 1;
    this.nextAt = new Date(
      failedAt.getTime() + recipientResolutionBackoffSeconds(this.attempts) * 1_000,
    );
  }
}

async function resolveTask(
  ids: string[], contacts: Record<string, AirtableRecord>, extraSnapshot = {},
  configuredFallback: string | null = fallbackEmail,
) {
  const store = new MemoryStore();
  const airtable = airtableSource(contacts);
  const logs: string[] = [];
  await resolveCommunicationEventRecipients({
    event: taskEvent(ids, extraSnapshot), airtable, store,
    tiemedFallbackEmail: configuredFallback, log: (message) => logs.push(message),
  });
  return { store, airtable, logs };
}

async function resolveService(ids: string[], contacts: Record<string, AirtableRecord>) {
  const store = new MemoryStore();
  const airtable = airtableSource(contacts);
  await resolveCommunicationEventRecipients({
    event: {
      id: "evtService",
      sourceEntityType: CommunicationSourceEntityType.SERVICE_ORDER,
      scenario: CommunicationScenario.REPAIR_RECEIVED,
      eventSnapshot: { contactRecordIds: ids },
    },
    airtable, store, tiemedFallbackEmail: fallbackEmail,
  });
  return { store, airtable };
}

function taskEvent(ids: string[], extraSnapshot = {}): RecipientResolutionEvent {
  return {
    id: "evtTask",
    sourceEntityType: CommunicationSourceEntityType.TASK,
    scenario: CommunicationScenario.INSPECTION_REMINDER,
    eventSnapshot: { selectedContactRecordIds: ids, ...extraSnapshot },
  };
}

function contact(id: string, email: string | null): AirtableRecord {
  return {
    id, createdTime: "2026-08-11T08:00:00.000Z",
    fields: {
      [CONTACT_FIELDS.name]: "Contact A",
      [CONTACT_FIELDS.contactable]: "TAK",
      [CONTACT_FIELDS.email]: email,
    },
  };
}

function airtableSource(records: Record<string, AirtableRecord>, failure?: Error) {
  return {
    fetchAllRecords: vi.fn(async () => []),
    fetchRecord: vi.fn(async (_tableId: string, recordId: string) => {
      if (failure) throw failure;
      const record = records[recordId];
      if (!record) throw new Error("missing fixture");
      return record;
    }),
  } satisfies AirtableIncrementalSource;
}

function ready(store: MemoryStore) {
  return store.recipients.filter((item) => item.resolutionStatus === CommunicationRecipientResolutionStatus.READY);
}
function invalid(store: MemoryStore) {
  return store.recipients.filter((item) => item.resolutionStatus === CommunicationRecipientResolutionStatus.INVALID);
}
function fallback(store: MemoryStore) {
  return store.recipients.filter((item) => item.resolutionStatus === CommunicationRecipientResolutionStatus.FALLBACK);
}
