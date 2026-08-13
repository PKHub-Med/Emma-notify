import { describe, expect, it, vi } from "vitest";
import { AirtableRequestError } from "../airtable/client.js";
import {
  BufferStatus,
  CaseType,
  EventType,
  SyncEntityType,
} from "../generated/prisma/enums.js";
import {
  AIRTABLE_TABLE_IDS,
  CONTACT_FIELDS,
  INSPECTION_FIELDS,
  SERVICE_ORDER_FIELDS,
} from "../airtable/field-ids.js";
import type { MappedCase } from "../airtable/mappers.js";
import type { ResolvedRecipient } from "../airtable/recipient.js";
import type {
  AirtableIncrementalSource,
  AirtableListOptions,
  AirtableRecord,
} from "../airtable/types.js";
import { calculateSendAfter, shouldMarkBufferReady } from "./notification-domain.js";
import { runIncrementalSync } from "./incremental-sync.js";
import type {
  IncrementalEntityType,
  IncrementalStore,
  StatusChangeCommand,
  StatusChangeResult,
  StoredCase,
} from "./incremental-store.js";
import { runWatchdog } from "./watchdog.js";
import type {
  CommunicationEventStore,
  CommunicationObservation,
  CommunicationObservationResult,
} from "./communication-event.js";

const CHECKPOINT = new Date("2026-08-08T09:00:00.000Z");

type MemoryBufferItem = {
  trackedCaseId: string;
  firstEventAt: Date;
  lastEventAt: Date;
};

type MemoryBuffer = {
  id: string;
  status: "OPEN" | "READY";
  normalizedEmail: string;
  activeRecipientKey: string | null;
  firstTriggerAt: Date;
  lastTriggerAt: Date;
  sendAfter: Date;
  items: Map<string, MemoryBufferItem>;
};

class FakeAirtable implements AirtableIncrementalSource {
  serviceOrders: AirtableRecord[] = [];
  inspections: AirtableRecord[] = [];
  contacts = new Map<string, AirtableRecord>();
  fetchedRecordTables: string[] = [];

  async fetchAllRecords(
    tableId: string,
    _fieldIds: readonly string[],
    _options?: AirtableListOptions,
  ): Promise<AirtableRecord[]> {
    if (tableId === AIRTABLE_TABLE_IDS.serviceOrders) return this.serviceOrders;
    if (tableId === AIRTABLE_TABLE_IDS.inspections) return this.inspections;
    return [];
  }

  async fetchRecord(
    tableId: string,
    recordId: string,
  ): Promise<AirtableRecord> {
    this.fetchedRecordTables.push(tableId);
    const contact = this.contacts.get(recordId);
    if (!contact) throw new Error("Missing fake contact");
    return contact;
  }
}

class MemoryStore implements IncrementalStore {
  readonly cases = new Map<string, StoredCase>();
  readonly recipients = new Map<string, ResolvedRecipient[]>();
  readonly events: Array<StatusChangeCommand & { triggersNotification: true }> = [];
  readonly fingerprints = new Set<string>();
  readonly buffers: MemoryBuffer[] = [];
  readonly checkpoints = new Map<IncrementalEntityType, Date>([
    [SyncEntityType.SERVICE_ORDER, CHECKPOINT],
    [SyncEntityType.INSPECTION, CHECKPOINT],
  ]);
  private nextCaseId = 1;
  private nextBufferId = 1;

  seedCase(caseType: CaseType, recordId: string, status: string | null): string {
    const id = `case-${this.nextCaseId++}`;
    this.cases.set(caseKey(caseType, recordId), { id, currentStatus: status });
    return id;
  }

  async getCheckpoint(entityType: IncrementalEntityType): Promise<Date | null> {
    return this.checkpoints.get(entityType) ?? null;
  }
  async markRunning(_entityType: IncrementalEntityType, _at: Date): Promise<void> {}
  async markSuccessful(entityType: IncrementalEntityType, at: Date): Promise<void> {
    this.checkpoints.set(entityType, at);
  }
  async markFailed(_entityType: IncrementalEntityType, _at: Date): Promise<void> {}
  async findCase(mappedCase: MappedCase): Promise<StoredCase | null> {
    return this.cases.get(caseKey(mappedCase.caseType, mappedCase.airtableRecordId)) ?? null;
  }
  async upsertCaseWithoutEvent(mappedCase: MappedCase): Promise<string> {
    const key = caseKey(mappedCase.caseType, mappedCase.airtableRecordId);
    const existing = this.cases.get(key);
    if (existing) {
      existing.currentStatus = mappedCase.currentStatus;
      return existing.id;
    }
    return this.seedCase(
      mappedCase.caseType,
      mappedCase.airtableRecordId,
      mappedCase.currentStatus,
    );
  }
  async syncRecipients(
    trackedCaseId: string,
    recipients: readonly ResolvedRecipient[],
  ): Promise<void> {
    this.recipients.set(trackedCaseId, [...recipients]);
  }
  async processStatusChange(command: StatusChangeCommand): Promise<StatusChangeResult> {
    if (this.fingerprints.has(command.fingerprint)) return duplicateResult();
    this.fingerprints.add(command.fingerprint);
    this.events.push({ ...command, triggersNotification: true });
    const stored = [...this.cases.values()].find(
      (item) => item.id === command.trackedCaseId,
    );
    if (stored) stored.currentStatus = command.newStatus;

    const recipients = new Map(
      (this.recipients.get(command.trackedCaseId) ?? [])
        .filter((recipient) => recipient.eligible && recipient.normalizedEmail)
        .map((recipient) => [recipient.normalizedEmail!, recipient]),
    );
    let buffersCreated = 0;
    let buffersReset = 0;
    let bufferItemsCreated = 0;
    for (const normalizedEmail of recipients.keys()) {
      let buffer = this.buffers.find(
        (item) => item.activeRecipientKey === normalizedEmail,
      );
      if (!buffer) {
        buffer = {
          id: `buffer-${this.nextBufferId++}`,
          status: BufferStatus.OPEN,
          normalizedEmail,
          activeRecipientKey: normalizedEmail,
          firstTriggerAt: command.detectedAt,
          lastTriggerAt: command.detectedAt,
          sendAfter: calculateSendAfter(command.detectedAt, command.quietMinutes),
          items: new Map(),
        };
        this.buffers.push(buffer);
        buffersCreated += 1;
      } else {
        buffer.lastTriggerAt = command.detectedAt;
        buffer.sendAfter = calculateSendAfter(command.detectedAt, command.quietMinutes);
        buffersReset += 1;
      }
      const item = buffer.items.get(command.trackedCaseId);
      if (item) {
        item.lastEventAt = command.detectedAt;
      } else {
        buffer.items.set(command.trackedCaseId, {
          trackedCaseId: command.trackedCaseId,
          firstEventAt: command.detectedAt,
          lastEventAt: command.detectedAt,
        });
        bufferItemsCreated += 1;
      }
    }
    return {
      duplicate: false,
      withoutRecipient: recipients.size === 0,
      buffersCreated,
      buffersReset,
      bufferItemsCreated,
    };
  }
  async markExpiredBuffersReady(now: Date): Promise<number> {
    let count = 0;
    for (const buffer of this.buffers) {
      if (shouldMarkBufferReady(buffer.status, buffer.sendAfter, now)) {
        buffer.status = BufferStatus.READY;
        buffer.activeRecipientKey = null;
        count += 1;
      }
    }
    return count;
  }
  async setWorkerLastSync(_at: Date): Promise<void> {}
}

class RecordingCommunicationStore implements CommunicationEventStore {
  readonly observations: CommunicationObservation[] = [];

  async isBaselineCompleted(): Promise<boolean> {
    return true;
  }

  async markBaselineCompleted(): Promise<void> {}

  async observe(
    observation: CommunicationObservation,
    _allowEvent: boolean,
    _detectedAt: Date,
  ): Promise<CommunicationObservationResult> {
    this.observations.push(observation);
    return { outcome: "CREATED", revision: 0, fingerprint: "fingerprint" };
  }
}

describe("incremental status sync", () => {
  it("never fetches Devices per Service Order", async () => {
    const source = new FakeAirtable();
    const store = new MemoryStore();
    source.contacts.set("recContact", eligibleContact("recContact", "one@example.com"));
    source.serviceOrders = [serviceRecord("recService", "B", ["recContact"] )];
    store.seedCase(CaseType.SERVICE_ORDER, "recService", "A");
    await run(source, store, date(0));
    expect(source.fetchedRecordTables).toEqual([AIRTABLE_TABLE_IDS.contacts]);
    expect(source.fetchedRecordTables).not.toContain(AIRTABLE_TABLE_IDS.devices);
  });

  it("logs SERVICE_ORDER Airtable metadata and allows the following poll to succeed", async () => {
    const source = new FakeAirtable();
    const store = new MemoryStore();
    const logs: string[] = [];
    const originalFetch = source.fetchAllRecords.bind(source);
    vi.spyOn(source, "fetchAllRecords")
      .mockRejectedValueOnce(new AirtableRequestError(
        "Airtable record request failed for table tblContact",
        AIRTABLE_TABLE_IDS.contacts,
        "RECORD",
        422,
      ))
      .mockImplementation(originalFetch);
    const poll = () => runIncrementalSync({
      airtable: source,
      store,
      options: { overlapSeconds: 120, quietMinutes: 1, legacyNotificationsEnabled: false },
      now: () => date(0),
      log: (message) => logs.push(message),
    });

    await expect(poll()).rejects.toThrow("Incremental synchronization stage failed");
    await expect(poll()).resolves.toMatchObject({ serviceOrdersFetched: 0 });
    expect(logs[0]).toContain("INCREMENTAL_SYNC_FAILED stage=SERVICE_ORDER");
    expect(logs[0]).toContain("errorCode=AIRTABLE_HTTP_422");
    expect(logs[0]).toContain("requestType=RECORD requestEntity=CONTACT httpStatus=422");
  });

  it("logs failures from INSPECTION, DB and COMMUNICATION with their exact stage", async () => {
    const cases: Array<{ expected: string; run: () => Promise<unknown>; logs: string[] }> = [];

    const inspectionSource = new FakeAirtable();
    const inspectionStore = new MemoryStore();
    const inspectionLogs: string[] = [];
    vi.spyOn(inspectionSource, "fetchAllRecords").mockImplementation(async (tableId) => {
      if (tableId === AIRTABLE_TABLE_IDS.inspections) throw new Error("inspection unavailable");
      return [];
    });
    cases.push({
      expected: "stage=INSPECTION",
      logs: inspectionLogs,
      run: () => runIncrementalSync({
        airtable: inspectionSource, store: inspectionStore,
        options: { overlapSeconds: 120, quietMinutes: 1, legacyNotificationsEnabled: false },
        now: () => date(0), log: (message) => inspectionLogs.push(message),
      }),
    });

    const dbSource = new FakeAirtable();
    const dbStore = new MemoryStore();
    const dbLogs: string[] = [];
    vi.spyOn(dbStore, "getCheckpoint").mockRejectedValue(Object.assign(
      new Error("query details must not be logged"), { code: "P2024" },
    ));
    cases.push({
      expected: "stage=DB",
      logs: dbLogs,
      run: () => runIncrementalSync({
        airtable: dbSource, store: dbStore,
        options: { overlapSeconds: 120, quietMinutes: 1, legacyNotificationsEnabled: false },
        now: () => date(0), log: (message) => dbLogs.push(message),
      }),
    });

    const communicationSource = new FakeAirtable();
    const communicationStore = new RecordingCommunicationStore();
    const communicationLogs: string[] = [];
    vi.spyOn(communicationStore, "isBaselineCompleted")
      .mockRejectedValue(new Error("Communication baseline read failed"));
    cases.push({
      expected: "stage=COMMUNICATION",
      logs: communicationLogs,
      run: () => runIncrementalSync({
        airtable: communicationSource, store: new MemoryStore(), communicationStore,
        options: { overlapSeconds: 120, quietMinutes: 1, legacyNotificationsEnabled: false },
        now: () => date(0), log: (message) => communicationLogs.push(message),
      }),
    });

    for (const testCase of cases) {
      await expect(testCase.run()).rejects.toThrow();
      expect(testCase.logs).toHaveLength(1);
      expect(testCase.logs[0]).toContain(`INCREMENTAL_SYNC_FAILED ${testCase.expected}`);
    }
    expect(dbLogs[0]).toContain("errorCode=P2024");
    expect(dbLogs[0]).not.toContain("query details");
  });

  it("does not create an event or buffer when legacy notifications are disabled", async () => {
    const fixture = serviceFixture("A", "B", [
      eligibleContact("recContact", "one@example.com"),
    ]);

    const stats = await runIncrementalSync({
      airtable: fixture.source,
      store: fixture.store,
      options: {
        overlapSeconds: 120,
        quietMinutes: 1,
        legacyNotificationsEnabled: false,
      },
      now: () => date(0),
    });

    expect(fixture.store.events).toHaveLength(0);
    expect(fixture.store.buffers).toHaveLength(0);
    expect(stats).toMatchObject({ eventsCreated: 0, buffersCreated: 0 });
    expect(fixture.store.cases.get(caseKey(CaseType.SERVICE_ORDER, "recService")))
      .toMatchObject({ currentStatus: "B" });
  });

  it("creates only a CommunicationEvent candidate for a supported EMMA pair", async () => {
    const source = new FakeAirtable();
    const store = new MemoryStore();
    const communicationStore = new RecordingCommunicationStore();
    source.serviceOrders = [serviceRecord(
      "recService",
      "Legacy changed",
      [],
      date(0),
      {
        [SERVICE_ORDER_FIELDS.emmaCustomerStatus]: "Diagnostyka",
        [SERVICE_ORDER_FIELDS.emmaMailTemplate]: "Naprawa-zmiana_stanu",
      },
    )];

    const stats = await runIncrementalSync({
      airtable: source,
      store,
      communicationStore,
      options: {
        overlapSeconds: 120,
        quietMinutes: 1,
        legacyNotificationsEnabled: false,
      },
      now: () => date(0),
    });

    expect(communicationStore.observations).toHaveLength(1);
    expect(communicationStore.observations[0]?.scenario).toBe("REPAIR_RECEIVED");
    expect(stats.communicationEventsCreated).toBe(1);
    expect(store.events).toHaveLength(0);
    expect(store.buffers).toHaveLength(0);
  });

  it("A. creates SERVICE_STATUS_CHANGED for service status A to B", async () => {
    const fixture = serviceFixture("A", "B");
    await fixture.run();
    expect(fixture.store.events).toHaveLength(1);
    expect(fixture.store.events[0]?.eventType).toBe(EventType.SERVICE_STATUS_CHANGED);
  });

  it("B. creates INSPECTION_STATUS_CHANGED for inspection status A to B", async () => {
    const source = new FakeAirtable();
    const store = new MemoryStore();
    store.seedCase(CaseType.INSPECTION, "recInspection", "A");
    source.inspections = [inspectionRecord("recInspection", "B")];
    await run(source, store, date(0));
    expect(store.events[0]?.eventType).toBe(EventType.INSPECTION_STATUS_CHANGED);
  });

  it("regression: inspection with refreshed eligible linked contact creates event, OPEN buffer and item", async () => {
    const source = new FakeAirtable();
    const store = new MemoryStore();
    store.seedCase(CaseType.INSPECTION, "recInspection19103", "A");
    source.contacts.set(
      "recInspectionContact",
      contactRecord("recInspectionContact", "TAK", "valid@example.com"),
    );
    source.inspections = [
      inspectionRecord("recInspection19103", "B", ["recInspectionContact"]),
    ];

    await run(source, store, date(0));

    expect(store.events).toHaveLength(1);
    expect(store.events[0]?.eventType).toBe(EventType.INSPECTION_STATUS_CHANGED);
    expect(store.events[0]?.triggersNotification).toBe(true);
    expect(store.buffers).toHaveLength(1);
    expect(store.buffers[0]?.status).toBe(BufferStatus.OPEN);
    expect(store.buffers[0]?.items.size).toBe(1);
  });

  it("uses a recipient refreshed in the same incremental run", async () => {
    const source = new FakeAirtable();
    const store = new MemoryStore();
    const trackedCaseId = store.seedCase(
      CaseType.INSPECTION,
      "recInspection19103",
      "A",
    );
    store.recipients.set(trackedCaseId, [{
      airtableContactRecordId: "recInspectionContact",
      name: null,
      email: null,
      normalizedEmail: null,
      eligible: false,
      eligibilityReason: "MISSING_EMAIL",
      resolutionSource: "CONTACT_LINK",
    }]);
    source.contacts.set(
      "recInspectionContact",
      contactRecord("recInspectionContact", "TAK", "new@example.com"),
    );
    source.inspections = [
      inspectionRecord("recInspection19103", "B", ["recInspectionContact"]),
    ];

    await run(source, store, date(0));

    expect(store.recipients.get(trackedCaseId)?.[0]?.eligible).toBe(true);
    expect(store.buffers).toHaveLength(1);
    expect(store.buffers[0]?.items.size).toBe(1);
  });

  it("accepts lowercase tak during same-run inspection recipient refresh", async () => {
    const source = new FakeAirtable();
    const store = new MemoryStore();
    store.seedCase(CaseType.INSPECTION, "recInspection19103", "A");
    source.contacts.set(
      "recInspectionContact",
      contactRecord("recInspectionContact", "tak", "valid@example.com"),
    );
    source.inspections = [
      inspectionRecord("recInspection19103", "B", ["recInspectionContact"]),
    ];

    await run(source, store, date(0));

    expect(store.events).toHaveLength(1);
    expect(store.buffers).toHaveLength(1);
  });

  it("creates an inspection event but no buffer for TAK with missing email", async () => {
    const source = new FakeAirtable();
    const store = new MemoryStore();
    store.seedCase(CaseType.INSPECTION, "recInspection19103", "A");
    source.contacts.set(
      "recInspectionContact",
      contactRecord("recInspectionContact", "TAK", null),
    );
    source.inspections = [
      inspectionRecord("recInspection19103", "B", ["recInspectionContact"]),
    ];

    await run(source, store, date(0));

    expect(store.events).toHaveLength(1);
    expect(store.buffers).toHaveLength(0);
  });

  it("C. ignores unchanged status including surrounding whitespace", async () => {
    const fixture = serviceFixture("Status", " Status ");
    await fixture.run();
    expect(fixture.store.events).toHaveLength(0);
  });

  it("D. keeps one event when overlap returns the same record again", async () => {
    const fixture = serviceFixture("A", "B");
    await fixture.run();
    await fixture.run();
    expect(fixture.store.events).toHaveLength(1);
  });

  it("E. creates one OPEN buffer and one item for an eligible recipient", async () => {
    const fixture = serviceFixture("A", "B", [eligibleContact("recContact", "one@example.com")]);
    await fixture.run();
    expect(fixture.store.buffers).toHaveLength(1);
    expect(fixture.store.buffers[0]?.status).toBe(BufferStatus.OPEN);
    expect(fixture.store.buffers[0]?.items.size).toBe(1);
  });

  it("F. groups two cases for one recipient into one buffer with two items", async () => {
    const source = new FakeAirtable();
    const store = new MemoryStore();
    source.contacts.set("recContact", eligibleContact("recContact", "one@example.com"));
    store.seedCase(CaseType.SERVICE_ORDER, "recA", "A");
    store.seedCase(CaseType.SERVICE_ORDER, "recB", "A");
    source.serviceOrders = [
      serviceRecord("recA", "B", ["recContact"]),
      serviceRecord("recB", "B", ["recContact"]),
    ];
    await run(source, store, date(0));
    expect(store.buffers).toHaveLength(1);
    expect(store.buffers[0]?.items.size).toBe(2);
  });

  it("G. resets sendAfter and lastEventAt for a repeated case change", async () => {
    const fixture = serviceFixture("A", "B", [eligibleContact("recContact", "one@example.com")]);
    await fixture.run(date(0));
    const firstSendAfter = fixture.store.buffers[0]!.sendAfter;
    fixture.source.serviceOrders = [serviceRecord("recService", "C", ["recContact"], date(30))];
    await fixture.run(date(30));
    const buffer = fixture.store.buffers[0]!;
    expect(fixture.store.buffers).toHaveLength(1);
    expect(buffer.items.size).toBe(1);
    expect(buffer.items.values().next().value?.lastEventAt).toEqual(date(30));
    expect(buffer.sendAfter.getTime()).toBeGreaterThan(firstSendAfter.getTime());
  });

  it("H. creates two independent buffers for two eligible recipients", async () => {
    const fixture = serviceFixture("A", "B", [
      eligibleContact("recOne", "one@example.com"),
      eligibleContact("recTwo", "two@example.com"),
    ]);
    await fixture.run();
    expect(fixture.store.buffers).toHaveLength(2);
  });

  it("I. persists an event without creating a buffer when no recipient is eligible", async () => {
    const fixture = serviceFixture("A", "B");
    const stats = await fixture.run();
    expect(fixture.store.events).toHaveLength(1);
    expect(fixture.store.buffers).toHaveLength(0);
    expect(stats.triggeringEventsWithoutRecipient).toBe(1);
  });

  it("L. creates a new OPEN buffer for an event after the previous buffer is READY", async () => {
    const fixture = serviceFixture("A", "B", [eligibleContact("recContact", "one@example.com")]);
    await fixture.run(date(0));
    await runWatchdog(fixture.store, date(61));
    fixture.source.serviceOrders = [serviceRecord("recService", "C", ["recContact"], date(70))];
    await fixture.run(date(70));
    expect(fixture.store.buffers).toHaveLength(2);
    expect(fixture.store.buffers[0]?.status).toBe(BufferStatus.READY);
    expect(fixture.store.buffers[1]?.status).toBe(BufferStatus.OPEN);
  });
});

describe("quiet-period watchdog", () => {
  it("J. leaves a buffer OPEN before sendAfter", async () => {
    const fixture = serviceFixture("A", "B", [eligibleContact("recContact", "one@example.com")]);
    await fixture.run(date(0));
    expect(await runWatchdog(fixture.store, date(59))).toBe(0);
    expect(fixture.store.buffers[0]?.status).toBe(BufferStatus.OPEN);
  });

  it("K. atomically marks an expired buffer READY and clears activeRecipientKey", async () => {
    const fixture = serviceFixture("A", "B", [eligibleContact("recContact", "one@example.com")]);
    await fixture.run(date(0));
    expect(await runWatchdog(fixture.store, date(60))).toBe(1);
    expect(fixture.store.buffers[0]).toMatchObject({
      status: BufferStatus.READY,
      activeRecipientKey: null,
    });
  });

  it("M. does not mark READY when a simultaneous event moved sendAfter", async () => {
    const fixture = serviceFixture("A", "B", [eligibleContact("recContact", "one@example.com")]);
    await fixture.run(date(0));
    fixture.source.serviceOrders = [serviceRecord("recService", "C", ["recContact"], date(60))];
    await fixture.run(date(60));
    expect(await runWatchdog(fixture.store, date(60))).toBe(0);
    expect(fixture.store.buffers[0]?.status).toBe(BufferStatus.OPEN);
    expect(fixture.store.buffers[0]?.sendAfter).toEqual(date(120));
  });
});

function serviceFixture(
  storedStatus: string,
  newStatus: string,
  contacts: AirtableRecord[] = [],
) {
  const source = new FakeAirtable();
  const store = new MemoryStore();
  store.seedCase(CaseType.SERVICE_ORDER, "recService", storedStatus);
  for (const contact of contacts) source.contacts.set(contact.id, contact);
  source.serviceOrders = [
    serviceRecord("recService", newStatus, contacts.map((contact) => contact.id)),
  ];
  return {
    source,
    store,
    run: (now = date(0)) => run(source, store, now),
  };
}

function run(source: FakeAirtable, store: MemoryStore, now: Date) {
  return runIncrementalSync({
    airtable: source,
    store,
    options: {
      overlapSeconds: 120,
      quietMinutes: 1,
      legacyNotificationsEnabled: true,
    },
    now: () => now,
  });
}

function serviceRecord(
  id: string,
  status: string,
  contactIds: string[] = [],
  modifiedAt = date(0),
  extraFields: Record<string, unknown> = {},
): AirtableRecord {
  return record(id, {
    [SERVICE_ORDER_FIELDS.customerStatus]: status,
    [SERVICE_ORDER_FIELDS.contactLinks]: contactIds,
    [SERVICE_ORDER_FIELDS.sourceModifiedAt]: modifiedAt.toISOString(),
    ...extraFields,
  });
}

function inspectionRecord(
  id: string,
  status: string,
  contactIds: string[] = [],
): AirtableRecord {
  return record(id, {
    [INSPECTION_FIELDS.currentStatus]: status,
    [INSPECTION_FIELDS.contactLinks]: contactIds,
    [INSPECTION_FIELDS.sourceModifiedAt]: date(0).toISOString(),
  });
}

function eligibleContact(id: string, email: string): AirtableRecord {
  return contactRecord(id, "TAK", email);
}

function contactRecord(
  id: string,
  contactable: string,
  email: string | null,
): AirtableRecord {
  return record(id, {
    [CONTACT_FIELDS.contactable]: contactable,
    ...(email === null ? {} : { [CONTACT_FIELDS.email]: email }),
  });
}

function record(id: string, fields: Record<string, unknown>): AirtableRecord {
  return { id, createdTime: date(-1).toISOString(), fields };
}

function date(seconds: number): Date {
  return new Date(Date.parse("2026-08-08T10:00:00.000Z") + seconds * 1_000);
}

function caseKey(caseType: CaseType, recordId: string): string {
  return `${caseType}:${recordId}`;
}

function duplicateResult(): StatusChangeResult {
  return {
    duplicate: true,
    withoutRecipient: false,
    buffersCreated: 0,
    buffersReset: 0,
    bufferItemsCreated: 0,
  };
}
