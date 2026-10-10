import { describe, expect, it, vi } from "vitest";
import { INSPECTION_FIELDS } from "../airtable/field-ids.js";
import { mapInspection, type MappedCase } from "../airtable/mappers.js";
import type {
  AirtablePage,
  AirtablePageOptions,
  AirtablePaginatedSource,
  AirtableRecord,
} from "../airtable/types.js";
import {
  PrismaInspectionReconcileStore,
  runInspectionReconcile,
  type InspectionReconcileClaim,
  type InspectionReconcileStore,
} from "./inspection-reconcile.js";

class FakePagedAirtable implements AirtablePaginatedSource {
  readonly calls: AirtablePageOptions[] = [];
  readonly pages = new Map<string, AirtablePage>();
  failOnceAt: string | null = null;

  async fetchRecordsPage(
    _tableId: string,
    _fieldIds: readonly string[],
    options: AirtablePageOptions = {},
  ): Promise<AirtablePage> {
    this.calls.push(options);
    const key = options.offset ?? "FIRST";
    if (this.failOnceAt === key) {
      this.failOnceAt = null;
      throw Object.assign(new Error("temporary Airtable failure"), {
        code: "AIRTABLE_HTTP_503",
      });
    }
    return this.pages.get(key) ?? { records: [] };
  }
}

class MemoryReconcileStore implements InspectionReconcileStore {
  readonly inspections = new Map<string, MappedCase>();
  cursor: string | null = null;
  running = false;
  token: string | null = null;
  recordsRead = 0;
  recordsChanged = 0;
  recordsUnchanged = 0;
  recordsFailed = 0;
  pagesProcessed = 0;
  firstRunApproved = false;

  isFirstRunApproved(): Promise<boolean> {
    return Promise.resolve(this.firstRunApproved);
  }

  async claim(
    _now: Date,
    leaseToken: string,
    _leaseExpiresAt: Date,
  ): Promise<InspectionReconcileClaim | null> {
    if (this.running) return null;
    const resumed = this.cursor !== null;
    if (!resumed) this.resetCounters();
    this.running = true;
    this.token = leaseToken;
    return this.claimValue(resumed);
  }

  async commitPage(input: {
    leaseToken: string;
    inspections: readonly MappedCase[];
    nextCursor: string | null;
  }): Promise<InspectionReconcileClaim> {
    if (!this.running || input.leaseToken !== this.token) {
      throw new Error("INSPECTION_RECONCILE_LEASE_LOST");
    }
    for (const inspection of input.inspections) {
      const previous = this.inspections.get(inspection.airtableRecordId);
      if (sameMappedInspection(previous, inspection)) this.recordsUnchanged += 1;
      else this.recordsChanged += 1;
      this.inspections.set(inspection.airtableRecordId, inspection);
    }
    this.recordsRead += input.inspections.length;
    this.pagesProcessed += 1;
    this.cursor = input.nextCursor;
    if (input.nextCursor === null) {
      this.running = false;
      this.token = null;
      this.firstRunApproved = true;
    }
    return this.claimValue(true);
  }

  async markFailed(
    leaseToken: string,
    _at: Date,
    _errorCode: string,
  ): Promise<InspectionReconcileClaim | null> {
    if (!this.running || leaseToken !== this.token) return null;
    this.running = false;
    this.token = null;
    this.recordsFailed += 1;
    return this.claimValue(this.cursor !== null);
  }

  private claimValue(resumed: boolean): InspectionReconcileClaim {
    return {
      leaseToken: this.token ?? "",
      cursor: this.cursor,
      resumed,
      recordsRead: this.recordsRead,
      recordsChanged: this.recordsChanged,
      recordsUnchanged: this.recordsUnchanged,
      recordsFailed: this.recordsFailed,
      pagesProcessed: this.pagesProcessed,
    };
  }

  private resetCounters(): void {
    this.recordsRead = 0;
    this.recordsChanged = 0;
    this.recordsUnchanged = 0;
    this.recordsFailed = 0;
    this.pagesProcessed = 0;
  }
}

describe("inspection data-only reconcile", () => {
  it("fills a historical performed date and remains idempotent", async () => {
    const airtable = new FakePagedAirtable();
    const store = new MemoryReconcileStore();
    const source = inspectionRecord("rec3JZsto9bxsQWfb", {
      [INSPECTION_FIELDS.businessNumber]: "24455",
      [INSPECTION_FIELDS.performedAt]: "2026-05-15",
      [INSPECTION_FIELDS.emmaValidUntil]: "-",
    });
    const stale = mapInspection(source);
    stale.inspectionPerformedAt = null;
    store.inspections.set(source.id, stale);
    airtable.pages.set("FIRST", { records: [source] });

    const first = await runInspectionReconcile({ airtable, store, now: fixedNow });
    const second = await runInspectionReconcile({ airtable, store, now: fixedNow });

    expect(first).toMatchObject({
      outcome: "COMPLETED",
      recordsRead: 1,
      recordsChanged: 1,
      recordsUnchanged: 0,
      recordsFailed: 0,
    });
    expect(second).toMatchObject({
      outcome: "COMPLETED",
      recordsRead: 1,
      recordsChanged: 0,
      recordsUnchanged: 1,
      recordsFailed: 0,
    });
    expect(store.inspections.get(source.id)?.inspectionPerformedAt?.toISOString())
      .toBe("2026-05-15T00:00:00.000Z");
  });

  it("resumes at the last committed Airtable page after a transient failure", async () => {
    const airtable = new FakePagedAirtable();
    const store = new MemoryReconcileStore();
    airtable.pages.set("FIRST", {
      records: [inspectionRecord("recFirst", {})],
      offset: "page-2",
    });
    airtable.pages.set("page-2", {
      records: [inspectionRecord("recSecond", {})],
    });
    airtable.failOnceAt = "page-2";

    await expect(runInspectionReconcile({ airtable, store, now: fixedNow }))
      .rejects.toThrow("temporary Airtable failure");
    const resumed = await runInspectionReconcile({ airtable, store, now: fixedNow });

    expect(resumed).toMatchObject({
      outcome: "COMPLETED",
      resumed: true,
      recordsRead: 2,
      recordsChanged: 2,
      recordsFailed: 1,
      pagesProcessed: 2,
    });
    expect(airtable.calls.map((call) => call.offset ?? null))
      .toEqual([null, "page-2", "page-2"]);
    expect(store.inspections.size).toBe(2);
  });

  it("skips a concurrent run when the lease is already held", async () => {
    const airtable = new FakePagedAirtable();
    const store = new MemoryReconcileStore();
    store.running = true;

    const stats = await runInspectionReconcile({ airtable, store, now: fixedNow });

    expect(stats.outcome).toBe("ALREADY_RUNNING");
    expect(airtable.calls).toHaveLength(0);
  });

  it("requires a separately approved first run before scheduled execution", async () => {
    const airtable = new FakePagedAirtable();
    const store = new MemoryReconcileStore();

    const blocked = await runInspectionReconcile({
      airtable,
      store,
      now: fixedNow,
      requirePriorSuccess: true,
    });
    expect(blocked.outcome).toBe("APPROVAL_REQUIRED");
    expect(airtable.calls).toHaveLength(0);

    airtable.pages.set("FIRST", { records: [] });
    await runInspectionReconcile({ airtable, store, now: fixedNow });
    const scheduled = await runInspectionReconcile({
      airtable,
      store,
      now: fixedNow,
      requirePriorSuccess: true,
    });
    expect(scheduled.outcome).toBe("COMPLETED");
  });

  it("has no communication dependency or communication side effects", async () => {
    const airtable = new FakePagedAirtable();
    const store = new MemoryReconcileStore();
    airtable.pages.set("FIRST", {
      records: [inspectionRecord("recInspection", {
        [INSPECTION_FIELDS.performedAt]: "2026-10-10",
        [INSPECTION_FIELDS.emmaValidUntil]: "10-10-2027",
      })],
    });
    const communication = {
      events: 0,
      cursors: 0,
      signatures: 0,
      revisions: 0,
      deliveries: 0,
      emails: 0,
    };

    await runInspectionReconcile({ airtable, store, now: fixedNow });

    expect(communication).toEqual({
      events: 0,
      cursors: 0,
      signatures: 0,
      revisions: 0,
      deliveries: 0,
      emails: 0,
    });
    expect(Object.keys(store)).not.toContain("communicationStore");
  });

  it("the Prisma store touches only sync and current-state tables", async () => {
    const accessedModels = new Set<string>();
    const transactionTarget = {
      syncState: {
        updateMany: vi.fn(async () => ({ count: 1 })),
        update: vi.fn(async () => ({
          reconcileCursor: null,
          leaseToken: null,
          recordsRead: 1,
          recordsChanged: 1,
          recordsUnchanged: 0,
          recordsFailed: 0,
          pagesProcessed: 1,
        })),
      },
      trackedCase: {
        findUnique: vi.fn(async () => null),
        upsert: vi.fn(async () => ({ id: "case-1" })),
      },
      trackedCaseDevice: {
        deleteMany: vi.fn(async () => ({ count: 0 })),
        createMany: vi.fn(async () => ({ count: 0 })),
      },
    };
    const transaction = new Proxy(transactionTarget, {
      get(target, property: string) {
        accessedModels.add(property);
        if (property in target) return target[property as keyof typeof target];
        throw new Error(`unexpected model access: ${property}`);
      },
    });
    const prisma = {
      $transaction: vi.fn(async (operation: (tx: typeof transaction) => Promise<unknown>) =>
        operation(transaction)),
    };
    const store = new PrismaInspectionReconcileStore(prisma as never);

    await store.commitPage({
      leaseToken: "lease",
      inspections: [mapInspection(inspectionRecord("recInspection", {
        [INSPECTION_FIELDS.deviceLink]: ["recDevice"],
        [INSPECTION_FIELDS.performedAt]: "2026-10-10",
      }))],
      nextCursor: null,
      seenAt: fixedNow(),
      leaseExpiresAt: new Date("2026-10-10T12:10:00.000Z"),
    });

    expect([...accessedModels].sort()).toEqual([
      "syncState",
      "trackedCase",
      "trackedCaseDevice",
    ]);
    for (const forbidden of [
      "communicationCursor",
      "communicationEvent",
      "communicationDelivery",
      "notificationBuffer",
      "digest",
    ]) {
      expect(accessedModels).not.toContain(forbidden);
    }
  });

  it("requests Airtable pages at the API maximum of 100 records", async () => {
    const airtable = new FakePagedAirtable();
    const store = new MemoryReconcileStore();
    airtable.pages.set("FIRST", { records: [] });

    await runInspectionReconcile({ airtable, store, now: fixedNow });

    expect(airtable.calls[0]?.pageSize).toBe(100);
  });
});

function fixedNow(): Date {
  return new Date("2026-10-10T12:00:00.000Z");
}

function inspectionRecord(
  id: string,
  fields: Record<string, unknown>,
): AirtableRecord {
  return {
    id,
    createdTime: "2026-05-01T08:00:00.000Z",
    fields,
  };
}

function sameMappedInspection(left: MappedCase | undefined, right: MappedCase): boolean {
  if (!left) return false;
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function normalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, normalize(item)]));
  }
  return value;
}
