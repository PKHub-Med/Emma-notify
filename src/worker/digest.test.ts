import { describe, expect, it } from "vitest";
import {
  BufferStatus,
  CaseType,
  EventType,
} from "../generated/prisma/enums.js";
import {
  buildCaseSnapshot,
  buildCustomerChangeSummary,
  buildDigestChanges,
  buildDigestSubject,
  type DigestCaseSnapshotSource,
  type DigestEventSource,
} from "./digest-domain.js";
import { createDigestFromBuffer } from "./digest-loop.js";
import type {
  DigestCreationResult,
  DigestStore,
} from "./digest-store.js";

type MemoryItem = {
  trackedCase: DigestCaseSnapshotSource;
  firstEventAt: Date;
  lastEventAt: Date;
  events: DigestEventSource[];
};

type MemoryBuffer = {
  id: string;
  status: "READY" | "CLOSED";
  recipientName: string | null;
  recipientEmail: string;
  normalizedEmail: string;
  items: MemoryItem[];
};

type MemoryDigestItem = {
  trackedCaseId: string;
  snapshot: ReturnType<typeof buildCaseSnapshot>;
  changes: ReturnType<typeof buildDigestChanges>;
};

type MemoryDigest = {
  id: string;
  sourceBufferId: string;
  type: "CASE_DIGEST";
  status: "CREATED";
  emailMode: "TEST" | "PRODUCTION";
  itemsCount: number;
  subject: string;
  items: MemoryDigestItem[];
};

class MemoryDigestStore implements DigestStore {
  readonly buffers = new Map<string, MemoryBuffer>();
  readonly digests: MemoryDigest[] = [];
  failItemCreation = false;

  async findReadyBufferIds(limit: number): Promise<string[]> {
    return [...this.buffers.values()]
      .filter((buffer) => buffer.status === BufferStatus.READY)
      .slice(0, limit)
      .map((buffer) => buffer.id);
  }

  async createDigestFromBuffer(
    bufferId: string,
    emailMode: "TEST" | "PRODUCTION",
  ): Promise<DigestCreationResult> {
    const buffer = this.buffers.get(bufferId);
    if (!buffer || buffer.status !== BufferStatus.READY) {
      return { outcome: "NOT_READY" };
    }
    const existing = this.digests.find(
      (digest) => digest.sourceBufferId === bufferId,
    );
    if (existing) {
      buffer.status = BufferStatus.CLOSED;
      return { outcome: "ALREADY_EXISTS", digestId: existing.id };
    }

    const items: MemoryDigestItem[] = [];
    for (const item of buffer.items) {
      items.push({
        trackedCaseId: item.trackedCase.airtableRecordId,
        snapshot: buildCaseSnapshot(item.trackedCase),
        changes: buildDigestChanges(item.events),
      });
      if (this.failItemCreation) throw new Error("Injected item failure");
    }

    const digest: MemoryDigest = {
      id: `digest-${this.digests.length + 1}`,
      sourceBufferId: buffer.id,
      type: "CASE_DIGEST",
      status: "CREATED",
      emailMode,
      itemsCount: items.length,
      subject: buildDigestSubject(items.length),
      items,
    };
    this.digests.push(digest);
    buffer.status = BufferStatus.CLOSED;
    return { outcome: "CREATED", digestId: digest.id, itemsCount: items.length };
  }
}

describe("digest creation", () => {
  it("turns one READY buffer item into one CREATED digest item and closes the buffer", async () => {
    const store = storeWithBuffer([caseItem("case-a", "A", "B", 0)]);

    await expect(createDigestFromBuffer(store, "buffer-1", "TEST")).resolves
      .toMatchObject({ outcome: "CREATED", itemsCount: 1 });

    expect(store.digests).toHaveLength(1);
    expect(store.digests[0]).toMatchObject({
      type: "CASE_DIGEST",
      status: "CREATED",
      emailMode: "TEST",
      itemsCount: 1,
    });
    expect(store.digests[0]?.items).toHaveLength(1);
    expect(store.digests[0]?.items[0]?.snapshot).not.toHaveProperty("email");
    expect(store.digests[0]?.items[0]?.snapshot).not.toHaveProperty("contacts");
    expect(store.digests[0]?.items[0]?.snapshot).not.toHaveProperty("sourceSnapshot");
    expect(store.buffers.get("buffer-1")?.status).toBe(BufferStatus.CLOSED);
  });

  it("creates one digest with three items for three cases in one buffer", async () => {
    const store = storeWithBuffer([
      caseItem("case-a", "A", "B", 0),
      caseItem("case-b", "A", "B", 0),
      caseItem("case-c", "A", "B", 0),
    ]);

    await createDigestFromBuffer(store, "buffer-1", "TEST");

    expect(store.digests).toHaveLength(1);
    expect(store.digests[0]?.itemsCount).toBe(3);
    expect(store.digests[0]?.items).toHaveLength(3);
  });

  it("keeps all case changes, final status snapshot and A-to-D customer summary", async () => {
    const item = caseItem("case-a", "A", "B", 0);
    item.events.push(
      event("B", "C", 10),
      event("C", "D", 20),
    );
    item.lastEventAt = date(20);
    item.trackedCase.currentStatus = "D";
    const store = storeWithBuffer([item]);

    await createDigestFromBuffer(store, "buffer-1", "TEST");

    const digestItem = store.digests[0]?.items[0];
    expect(digestItem?.snapshot.currentStatus).toBe("D");
    expect(digestItem?.changes).toHaveLength(3);
    expect(buildCustomerChangeSummary(digestItem?.changes ?? [])).toEqual({
      type: "STATUS_CHANGED",
      from: "A",
      to: "D",
    });
  });

  it("is idempotent when createDigestFromBuffer is called twice", async () => {
    const store = storeWithBuffer([caseItem("case-a", "A", "B", 0)]);

    await createDigestFromBuffer(store, "buffer-1", "TEST");
    await createDigestFromBuffer(store, "buffer-1", "TEST");

    expect(store.digests).toHaveLength(1);
    expect(store.digests[0]?.items).toHaveLength(1);
  });

  it("rolls back and leaves the buffer READY when DigestItem creation fails", async () => {
    const store = storeWithBuffer([caseItem("case-a", "A", "B", 0)]);
    store.failItemCreation = true;

    await expect(createDigestFromBuffer(store, "buffer-1", "TEST"))
      .rejects.toThrow("Injected item failure");

    expect(store.digests).toHaveLength(0);
    expect(store.buffers.get("buffer-1")?.status).toBe(BufferStatus.READY);
  });
});

function storeWithBuffer(items: MemoryItem[]): MemoryDigestStore {
  const store = new MemoryDigestStore();
  store.buffers.set("buffer-1", {
    id: "buffer-1",
    status: BufferStatus.READY,
    recipientName: "Customer",
    recipientEmail: "customer@example.com",
    normalizedEmail: "customer@example.com",
    items,
  });
  return store;
}

function caseItem(
  airtableRecordId: string,
  oldStatus: string,
  newStatus: string,
  seconds: number,
): MemoryItem {
  return {
    trackedCase: {
      caseType: CaseType.SERVICE_ORDER,
      airtableRecordId,
      businessNumber: airtableRecordId,
      clientOrderNumber: null,
      caseSubtype: null,
      caseLocation: null,
      hospitalName: "Hospital",
      deviceAirtableId: "device-1",
      deviceName: "Device",
      manufacturer: "Manufacturer",
      model: "Model",
      serialNumber: "Serial",
      inventoryNumber: "Inventory",
      currentStatus: newStatus,
      faultDescription: "Fault",
      inspectionDueDate: null,
      inspectionScheduledDate: null,
      inspectionBookingStatus: null,
      sourceModifiedAt: date(seconds),
    },
    firstEventAt: date(seconds),
    lastEventAt: date(seconds),
    events: [event(oldStatus, newStatus, seconds)],
  };
}

function event(
  oldValue: string,
  newValue: string,
  seconds: number,
): DigestEventSource {
  return {
    eventType: EventType.SERVICE_STATUS_CHANGED,
    fieldName: "STATUS",
    oldValue,
    newValue,
    detectedAt: date(seconds),
  };
}

function date(seconds: number): Date {
  return new Date(Date.parse("2026-08-08T10:00:00.000Z") + seconds * 1_000);
}
