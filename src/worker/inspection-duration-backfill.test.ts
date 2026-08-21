import { describe, expect, it, vi } from "vitest";
import { AIRTABLE_TABLE_IDS, INSPECTION_FIELDS } from "../airtable/field-ids.js";
import {
  PrismaInspectionDurationBackfillStore,
  runInspectionDurationBackfill,
  type InspectionDurationBackfillStore,
} from "./inspection-duration-backfill.js";

describe("inspection duration backfill", () => {
  it("production store updates only TrackedCase.sourceSnapshot in transactions", async () => {
    const executeRaw = vi.fn(() => Promise.resolve(1));
    const transaction = vi.fn(async (operations: Promise<unknown>[]) => Promise.all(operations));
    const prisma = { $executeRaw: executeRaw, $transaction: transaction };
    const result = await new PrismaInspectionDurationBackfillStore(prisma as never)
      .applyChanges([{ id: "case-1", estimatedDurationSeconds: 1800 }]);
    expect(result).toEqual({ updated: 1, failed: 0 });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(executeRaw).toHaveBeenCalledTimes(1);
    expect(prisma).not.toHaveProperty("communicationEvent");
    expect(prisma).not.toHaveProperty("communicationDelivery");
  });

  it("reports dry-run without writes and distinguishes changed, missing and unchanged", async () => {
    const store = fixtureStore([
      stored("a", {}), stored("b", { estimatedDurationSeconds: 3600 }),
      stored("c", {}), stored("d", {}),
    ]);
    const airtable = source([
      record("a", 1800), record("b", 3600), record("c", undefined), record("d", 5400),
    ]);
    const report = await runInspectionDurationBackfill({
      airtable, store, mode: "dry-run", log: () => undefined,
    });
    expect(report).toEqual({ mode: "dry-run", scanned: 4, withSourceValue: 3,
      missing: 1, changed: 2, unchanged: 2, failed: 0 });
    expect(store.applyChanges).not.toHaveBeenCalled();
    expect(airtable.fetchAllRecords).toHaveBeenCalledWith(
      AIRTABLE_TABLE_IDS.inspections, [INSPECTION_FIELDS.estimatedDuration]);
  });

  it("apply changes only source snapshot duration and has no communication side effects", async () => {
    const rows = [stored("a", { businessNumber: "I-1" }), stored("b", {
      businessNumber: "I-2", estimatedDurationSeconds: 3600,
    })];
    const store = fixtureStore(rows);
    const report = await runInspectionDurationBackfill({
      airtable: source([record("a", 5400), record("b", 3600)]),
      store, mode: "apply", log: () => undefined,
    });
    expect(store.applyChanges).toHaveBeenCalledWith([
      { id: "db-a", estimatedDurationSeconds: 5400 },
    ]);
    expect(report).toEqual({ mode: "apply", scanned: 2, withSourceValue: 2,
      missing: 0, changed: 1, unchanged: 1, failed: 0 });
    expect(rows[0]!.sourceSnapshot).toEqual({ businessNumber: "I-1" });
  });
});

function fixtureStore(rows: ReturnType<typeof stored>[]) {
  return {
    findInspections: vi.fn(async () => rows),
    applyChanges: vi.fn(async (changes) => ({ updated: changes.length, failed: 0 })),
  } satisfies InspectionDurationBackfillStore;
}

function source(records: ReturnType<typeof record>[]) {
  return { fetchAllRecords: vi.fn(async () => records) } as never;
}

function record(id: string, duration: unknown) {
  return { id, createdTime: "2026-08-01T00:00:00Z", fields: {
    ...(duration === undefined ? {} : { [INSPECTION_FIELDS.estimatedDuration]: duration }),
  } };
}

function stored(id: string, sourceSnapshot: Record<string, unknown>) {
  return { id: `db-${id}`, airtableRecordId: id, sourceSnapshot };
}
