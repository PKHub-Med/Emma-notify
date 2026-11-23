import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  ALL_FEEDBACK_FIELD_IDS,
  FEEDBACK_FIELDS,
  FEEDBACK_STATUS,
  FEEDBACK_TABLE_IDS,
} from "../airtable/feedback-fields.js";
import {
  CONTACT_FIELD_IDS,
  DEVICE_FIELD_IDS,
  HOSPITAL_FIELD_IDS,
  INSPECTION_FIELD_IDS,
  SERVICE_ORDER_FIELD_IDS,
  TASK_FIELD_IDS,
} from "../airtable/field-ids.js";
import { TASK_EDITABLE_FIELD_IDS } from "./task-sync.js";
import {
  buildFeedbackFields,
  deliveryFeedbackEntry,
  feedbackFingerprint,
  feedbackReasonLabel,
  runAirtableFeedbackOnce,
  targetsForEvent,
  type AirtableFeedbackStore,
  type FeedbackDelivery,
  type FeedbackEntry,
  type FeedbackTarget,
  type PendingFeedbackRecord,
} from "./airtable-feedback.js";

const at = (value: string) => new Date(value);

function delivery(overrides: Partial<FeedbackDelivery> = {}): FeedbackDelivery {
  return {
    id: "del1",
    status: "SENT",
    scenario: "REPAIR_COMPLETED",
    scheduledFor: at("2026-11-23T05:00:00.000Z"),
    sentAt: at("2026-11-23T05:00:10.000Z"),
    failedAt: null,
    nextRetryAt: null,
    updatedAt: at("2026-11-23T05:00:10.000Z"),
    cancelReason: null,
    lastError: null,
    emailMode: "PRODUCTION",
    actualRecipientEmail: "dt@szpital.pl",
    recipient: {
      recipientType: "CLIENT",
      email: "dt@szpital.pl",
      recipientKey: "dt@szpital.pl",
      resolutionReason: null,
    },
    ...overrides,
  };
}

describe("feedback field safety", () => {
  it("never lets write-back columns enter any synchronization field list", () => {
    const syncFields = new Set([
      ...SERVICE_ORDER_FIELD_IDS, ...INSPECTION_FIELD_IDS, ...TASK_FIELD_IDS,
      ...TASK_EDITABLE_FIELD_IDS, ...CONTACT_FIELD_IDS, ...DEVICE_FIELD_IDS,
      ...HOSPITAL_FIELD_IDS,
    ]);
    expect(ALL_FEEDBACK_FIELD_IDS).toHaveLength(18);
    for (const fieldId of ALL_FEEDBACK_FIELD_IDS) {
      expect(syncFields.has(fieldId)).toBe(false);
    }
  });

  it("keeps synchronization on the read-only token and client", () => {
    const client = readFileSync("src/airtable/client.ts", "utf8");
    expect(client).not.toMatch(/method:\s*"(?:PATCH|POST|PUT|DELETE)"/);
    const worker = readFileSync("src/worker/index.ts", "utf8");
    expect(worker).toContain("personalAccessToken: config.airtableWritePat");
    expect(worker).toContain("personalAccessToken: config.airtablePat");
  });
});

describe("deliveryFeedbackEntry", () => {
  it("maps a sent client email", () => {
    expect(deliveryFeedbackEntry(delivery())).toEqual({
      key: "delivery:del1",
      at: at("2026-11-23T05:00:10.000Z"),
      scenario: "REPAIR_COMPLETED",
      status: FEEDBACK_STATUS.SENT,
      recipient: "dt@szpital.pl",
      reason: null,
    });
  });

  it("marks a blocked email rerouted to Tiemed as blocked with the cause", () => {
    const entry = deliveryFeedbackEntry(delivery({
      actualRecipientEmail: "serwis@tiemed.pl",
      recipient: {
        recipientType: "TIEMED_FALLBACK",
        email: "serwis@tiemed.pl",
        recipientKey: "BLOCKED:del1:serwis@tiemed.pl",
        resolutionReason: "REPAIR_DEVICE_DATA_PENDING",
      },
    }));
    expect(entry?.status).toBe(FEEDBACK_STATUS.BLOCKED);
    expect(entry?.reason).toBe("Wysłano do Tiemed zamiast do klienta: Brak danych urządzenia");
    expect(entry?.recipient).toBe("serwis@tiemed.pl");
  });

  it("reports the Tiemed fallback when the client address is empty", () => {
    const entry = deliveryFeedbackEntry(delivery({
      scenario: "INSPECTION_DATE_CONFIRMED",
      recipient: {
        recipientType: "TIEMED_FALLBACK",
        email: "serwis@tiemed.pl",
        recipientKey: "serwis@tiemed.pl",
        resolutionReason: "TASK_EMMA_MAIL_DT_EMPTY",
      },
    }));
    expect(entry?.status).toBe(FEEDBACK_STATUS.SENT);
    expect(entry?.reason).toBe("Brak adresu klienta – wysłano do Tiemed");
  });

  it("maps failures, cancellations, scheduling and test mode", () => {
    expect(deliveryFeedbackEntry(delivery({
      status: "FAILED", sentAt: null, failedAt: at("2026-11-23T06:00:00.000Z"),
      lastError: "RESEND_RATE_LIMITED", nextRetryAt: at("2026-11-23T06:05:00.000Z"),
    }))).toMatchObject({
      status: FEEDBACK_STATUS.FAILED,
      reason: "Limit dostawcy poczty – ponowienie (ponowienie zaplanowane)",
    });
    expect(deliveryFeedbackEntry(delivery({
      status: "CANCELLED", sentAt: null, cancelReason: "RECIPIENT_OPTED_OUT",
    }))?.status).toBe(FEEDBACK_STATUS.BLOCKED);
    expect(deliveryFeedbackEntry(delivery({
      status: "CANCELLED", sentAt: null, cancelReason: "REMINDER_EXPIRED",
    }))).toMatchObject({ status: FEEDBACK_STATUS.CANCELLED, reason: "Przypomnienie straciło aktualność" });
    expect(deliveryFeedbackEntry(delivery({ status: "SCHEDULED", sentAt: null })))
      .toMatchObject({ status: FEEDBACK_STATUS.SCHEDULED, at: at("2026-11-23T05:00:00.000Z") });
    expect(deliveryFeedbackEntry(delivery({ emailMode: "TEST" }))?.reason).toBe("[TRYB TESTOWY]");
  });

  it("falls back to the raw code for unknown reasons", () => {
    expect(feedbackReasonLabel("SOMETHING_NEW")).toBe("SOMETHING_NEW");
    expect(feedbackReasonLabel("BLOCKED_CLIENT:OPTED_OUT")).toBe("Odbiorca wypisał się z powiadomień");
    expect(feedbackReasonLabel(null)).toBeNull();
  });
});

describe("buildFeedbackFields", () => {
  const entry = (index: number, overrides: Partial<FeedbackEntry> = {}): FeedbackEntry => ({
    key: `delivery:${index}`,
    at: new Date(Date.UTC(2026, 10, index, 10, 0)),
    scenario: "REPAIR_RECEIVED",
    status: FEEDBACK_STATUS.SENT,
    recipient: "dt@szpital.pl",
    reason: null,
    ...overrides,
  });

  it("writes the newest email and only the last five history lines", () => {
    const fields = buildFeedbackFields(
      "SERVICE_ORDER",
      [1, 2, 3, 4, 5, 6, 7].map((index) => entry(index, index === 7
        ? { scenario: "REPAIR_COMPLETED", status: FEEDBACK_STATUS.FAILED, reason: "Błąd wysyłki" }
        : {})),
      "Europe/Warsaw",
    )!;
    const ids = FEEDBACK_FIELDS.SERVICE_ORDER;
    expect(fields[ids.type]).toBe("Naprawa zakończona");
    expect(fields[ids.status]).toBe("Błąd");
    expect(fields[ids.date]).toBe("2026-11-07T10:00:00.000Z");
    expect(fields[ids.reason]).toBe("Błąd wysyłki");
    const lines = fields[ids.history]!.split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe("07.11.2026 11:00 · Naprawa zakończona · Błąd · dt@szpital.pl · Błąd wysyłki");
    expect(lines[4]).toContain("03.11.2026");
  });

  it("deduplicates the same delivery seen through several events", () => {
    const fields = buildFeedbackFields("INSPECTION", [entry(1), entry(1)], "Europe/Warsaw")!;
    expect(fields[FEEDBACK_FIELDS.INSPECTION.history]!.split("\n")).toHaveLength(1);
  });

  it("writes nothing for a record without communication", () => {
    expect(buildFeedbackFields("TASK", [], "Europe/Warsaw")).toBeNull();
  });

  it("produces a stable fingerprint", () => {
    expect(feedbackFingerprint({ b: "2", a: null })).toBe(feedbackFingerprint({ a: null, b: "2" }));
  });
});

describe("targetsForEvent", () => {
  it("maps repairs to orders and tasks to the task plus its inspections", () => {
    expect(targetsForEvent({
      sourceEntityType: "SERVICE_ORDER", sourceRecordId: "recSO", eventSnapshot: {},
    })).toEqual([{ table: "SERVICE_ORDER", recordId: "recSO" }]);
    expect(targetsForEvent({
      sourceEntityType: "TASK",
      sourceRecordId: "recTask",
      eventSnapshot: { linkedInspectionRecordIds: ["recI1", "recI2", "recI1"] },
    })).toEqual([
      { table: "TASK", recordId: "recTask" },
      { table: "INSPECTION", recordId: "recI1" },
      { table: "INSPECTION", recordId: "recI2" },
    ]);
  });
});

describe("runAirtableFeedbackOnce", () => {
  class MemoryStore implements AirtableFeedbackStore {
    cursor: Date | null = null;
    changed: FeedbackTarget[] = [];
    records: Array<PendingFeedbackRecord & { pending: boolean; lastError?: string }> = [];
    entries = new Map<string, FeedbackEntry[]>();

    async getOrInitCursor(now: Date) { this.cursor ??= now; return this.cursor; }
    async saveCursor(value: Date) { this.cursor = value; }
    async findChangedTargets() { return this.changed; }
    async markDirty(targets: readonly FeedbackTarget[]) {
      for (const target of targets) {
        const existing = this.records.find((record) =>
          record.table === target.table && record.recordId === target.recordId);
        if (existing) existing.pending = true;
        else this.records.push({
          id: `${target.table}:${target.recordId}`, ...target,
          fingerprint: null, attemptCount: 0, pending: true,
        });
      }
    }
    async claimPending() { return this.records.filter((record) => record.pending); }
    async loadEntries(target: FeedbackTarget) {
      return this.entries.get(`${target.table}:${target.recordId}`) ?? [];
    }
    async markWritten(id: string, fingerprint: string | null) {
      const record = this.records.find((item) => item.id === id)!;
      record.fingerprint = fingerprint;
      record.pending = false;
    }
    async markFailed(record: PendingFeedbackRecord, error: string) {
      const stored = this.records.find((item) => item.id === record.id)!;
      stored.attemptCount += 1;
      stored.lastError = error;
    }
  }

  const sentEntry: FeedbackEntry = {
    key: "delivery:1", at: at("2026-11-23T10:00:00.000Z"), scenario: "REPAIR_COMPLETED",
    status: FEEDBACK_STATUS.SENT, recipient: "dt@szpital.pl", reason: null,
  };

  it("starts from now without backfilling and then writes changed records once", async () => {
    const store = new MemoryStore();
    const writer = { updateRecords: vi.fn(async () => undefined) };
    let now = at("2026-11-23T10:00:00.000Z");
    store.changed = [{ table: "SERVICE_ORDER", recordId: "recOld" }];

    const first = await runAirtableFeedbackOnce({
      store, writer, timeZone: "Europe/Warsaw", now: () => now,
    });
    expect(first.marked).toBe(0);
    expect(writer.updateRecords).not.toHaveBeenCalled();

    now = at("2026-11-23T10:01:00.000Z");
    store.changed = [{ table: "SERVICE_ORDER", recordId: "recSO" }];
    store.entries.set("SERVICE_ORDER:recSO", [sentEntry]);
    const second = await runAirtableFeedbackOnce({
      store, writer, timeZone: "Europe/Warsaw", now: () => now,
    });
    expect(second).toMatchObject({ marked: 1, written: 1 });
    expect(writer.updateRecords).toHaveBeenCalledWith(FEEDBACK_TABLE_IDS.SERVICE_ORDER, [{
      id: "recSO",
      fields: expect.objectContaining({ [FEEDBACK_FIELDS.SERVICE_ORDER.status]: "Wysłany" }),
    }]);

    now = at("2026-11-23T10:02:00.000Z");
    const third = await runAirtableFeedbackOnce({
      store, writer, timeZone: "Europe/Warsaw", now: () => now,
    });
    expect(third).toMatchObject({ written: 0, skipped: 1 });
    expect(writer.updateRecords).toHaveBeenCalledTimes(1);
  });

  it("isolates a failing record inside a batch and keeps the others", async () => {
    const store = new MemoryStore();
    store.cursor = at("2026-11-23T09:00:00.000Z");
    store.changed = [
      { table: "TASK", recordId: "recGood" },
      { table: "TASK", recordId: "recDeleted" },
    ];
    store.entries.set("TASK:recGood", [{ ...sentEntry, scenario: "INSPECTION_REMINDER" }]);
    store.entries.set("TASK:recDeleted", [{ ...sentEntry, scenario: "INSPECTION_REMINDER" }]);
    const writer = {
      updateRecords: vi.fn(async (_table: string, records: readonly { id: string }[]) => {
        if (records.some((record) => record.id === "recDeleted")) {
          throw new Error("ROW_DOES_NOT_EXIST");
        }
      }),
    };

    const result = await runAirtableFeedbackOnce({
      store, writer, timeZone: "Europe/Warsaw", now: () => at("2026-11-23T10:00:00.000Z"),
    });

    expect(result).toMatchObject({ written: 1, failed: 1 });
    expect(store.records.find((record) => record.recordId === "recGood")?.pending).toBe(false);
    expect(store.records.find((record) => record.recordId === "recDeleted")?.attemptCount).toBe(1);
  });
});
