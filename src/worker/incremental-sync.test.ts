import { describe, expect, it } from "vitest";
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
    _tableId: string,
    recordId: string,
  ): Promise<AirtableRecord> {
    const contact = this.contacts.get(recordId);
    if (!contact) throw new Error("Missing fake contact");
    return contact;
  }
}

class MemoryStore implements IncrementalStore {
  readonly cases = new Map<string, StoredCase>();
  readonly recipients = new Map<string, ResolvedRecipient[]>();
  readonly events: StatusChangeCommand[] = [];
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
    this.events.push(command);
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

describe("incremental status sync", () => {
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
    options: { overlapSeconds: 120, quietMinutes: 1 },
    now: () => now,
  });
}

function serviceRecord(
  id: string,
  status: string,
  contactIds: string[] = [],
  modifiedAt = date(0),
): AirtableRecord {
  return record(id, {
    [SERVICE_ORDER_FIELDS.customerStatus]: status,
    [SERVICE_ORDER_FIELDS.contactLinks]: contactIds,
    [SERVICE_ORDER_FIELDS.sourceModifiedAt]: modifiedAt.toISOString(),
  });
}

function inspectionRecord(id: string, status: string): AirtableRecord {
  return record(id, {
    [INSPECTION_FIELDS.currentStatus]: status,
    [INSPECTION_FIELDS.sourceModifiedAt]: date(0).toISOString(),
  });
}

function eligibleContact(id: string, email: string): AirtableRecord {
  return record(id, {
    [CONTACT_FIELDS.contactable]: "TAK",
    [CONTACT_FIELDS.email]: email,
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
