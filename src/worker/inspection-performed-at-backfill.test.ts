import { describe, expect, it, vi } from "vitest";
import { INSPECTION_FIELDS } from "../airtable/field-ids.js";
import { runInspectionPerformedAtBackfill } from "./inspection-performed-at-backfill.js";

describe("inspection performed-at backfill", () => {
  it("is read-only in dry-run mode and requests only the performed-at field", async () => {
    const fetchAllRecords = vi.fn(async () => [record("recOne", undefined)]);
    const updateMany = vi.fn();
    const prisma = {
      trackedCase: {
        findMany: vi.fn(async () => [{
          airtableRecordId: "recOne",
          inspectionPerformedAt: new Date("2026-08-04T00:00:00.000Z"),
        }]),
        updateMany,
      },
    };

    const result = await runInspectionPerformedAtBackfill({
      prisma: prisma as never,
      airtable: { fetchAllRecords } as never,
      mode: "dry-run",
      log: () => undefined,
    });

    expect(fetchAllRecords).toHaveBeenCalledWith(expect.any(String), [INSPECTION_FIELDS.performedAt]);
    expect(result).toMatchObject({ updates: 1, setToDate: 0, setToNull: 1 });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("updates only inspectionPerformedAt and clears stale values when Airtable is empty", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const transactionClient = { trackedCase: { updateMany } };
    const prisma = {
      trackedCase: { findMany: vi.fn(async () => [
        { airtableRecordId: "recEmpty", inspectionPerformedAt: new Date("2026-08-04T00:00:00.000Z") },
        { airtableRecordId: "recDate", inspectionPerformedAt: null },
      ]) },
      $transaction: vi.fn(async (operation: (tx: typeof transactionClient) => Promise<void>) =>
        operation(transactionClient)),
    };

    const result = await runInspectionPerformedAtBackfill({
      prisma: prisma as never,
      airtable: { fetchAllRecords: async () => [
        record("recEmpty", undefined),
        record("recDate", "2026-08-05"),
      ] } as never,
      mode: "apply",
      log: () => undefined,
    });

    expect(result).toMatchObject({ updates: 2, setToDate: 1, setToNull: 1 });
    expect(updateMany).toHaveBeenCalledTimes(2);
    expect(updateMany.mock.calls.map(([input]) => input.data)).toEqual([
      { inspectionPerformedAt: null },
      { inspectionPerformedAt: new Date("2026-08-05T00:00:00.000Z") },
    ]);
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({
      isolationLevel: "Serializable",
    }));
  });
});

function record(id: string, performedAt: string | undefined) {
  return {
    id,
    createdTime: "2026-08-01T08:00:00.000Z",
    fields: performedAt === undefined ? {} : { [INSPECTION_FIELDS.performedAt]: performedAt },
  };
}
