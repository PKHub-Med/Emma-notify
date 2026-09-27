import { describe, expect, it, vi } from "vitest";
import { AIRTABLE_TABLE_IDS, INSPECTION_FIELDS } from "../airtable/field-ids.js";
import {
  InspectionPortalDatesBackfillApplyError,
  runInspectionPortalDatesBackfill,
} from "./inspection-portal-dates-backfill.js";

describe("inspection portal dates backfill", () => {
  it("reports field-level changes and performs no writes in dry-run mode", async () => {
    const updateMany = vi.fn();
    const prisma = fixturePrisma([
      stored("db-27190", "rec2QXkBuCSLO6oeB", "27190", null, null),
      stored("db-same", "recSame", "27191", "2026-10-02", "2027-10-02"),
    ], updateMany);
    const fetchAllRecords = vi.fn(async () => [
      record("rec2QXkBuCSLO6oeB", "27190", "2026-09-30", "01-09-2027"),
      record("recSame", "27191", "2026-10-02", "02-10-2027"),
    ]);

    const report = await runInspectionPortalDatesBackfill({
      prisma: prisma as never,
      airtable: { fetchAllRecords } as never,
      mode: "dry-run",
      log: () => undefined,
    });

    expect(fetchAllRecords).toHaveBeenCalledWith(AIRTABLE_TABLE_IDS.inspections, [
      INSPECTION_FIELDS.businessNumber,
      INSPECTION_FIELDS.scheduledDate,
      INSPECTION_FIELDS.emmaValidUntil,
    ]);
    expect(report.changes).toEqual([{
      businessNumber: "27190",
      sourceRecordId: "rec2QXkBuCSLO6oeB",
      inspectionScheduledDate: {
        old: null,
        new: new Date("2026-09-30T00:00:00.000Z"),
      },
      inspectionValidUntil: {
        old: null,
        new: new Date("2027-09-01T00:00:00.000Z"),
      },
    }]);
    expect(report.summary).toEqual({
      checked: 2,
      UPDATED: 1,
      SKIPPED_INVALID_VALID_UNTIL: 0,
      SKIPPED_AIRTABLE_RECORD_MISSING: 0,
      UNCHANGED: 1,
      FAILED: 0,
      scheduledDateChanges: 1,
      validUntilChanges: 1,
    });
    expect(updateMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("apply updates only the two portal date columns for active inspections", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const prisma = fixturePrisma([
      stored("db-1", "recOne", "1", null, null),
    ], updateMany);

    await runInspectionPortalDatesBackfill({
      prisma: prisma as never,
      airtable: { fetchAllRecords: async () => [
        record("recOne", "1", "2026-10-01", "01-10-2027"),
      ] } as never,
      mode: "apply",
      log: () => undefined,
    });

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: "db-1",
        caseType: "INSPECTION",
        active: true,
        inspectionScheduledDate: null,
        inspectionValidUntil: null,
      },
      data: {
        inspectionScheduledDate: new Date("2026-10-01T00:00:00.000Z"),
        inspectionValidUntil: new Date("2027-10-01T00:00:00.000Z"),
      },
    });
    expect(prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: "Serializable" }),
    );
  });

  it("reports an invalid scheduled date as a fatal failure and refuses apply", async () => {
    const updateMany = vi.fn();
    const prisma = fixturePrisma([
      stored("db-1", "recOne", "1", null, null),
    ], updateMany);
    const input = {
      prisma: prisma as never,
      airtable: { fetchAllRecords: async () => [
        record("recOne", "1", "10/01/2026", "—"),
      ] } as never,
      log: () => undefined,
    };

    const dryRun = await runInspectionPortalDatesBackfill({ ...input, mode: "dry-run" });
    expect(dryRun.summary).toMatchObject({ checked: 1, UNCHANGED: 0, FAILED: 1 });
    expect(dryRun.failed).toEqual([{
      businessNumber: "1",
      sourceRecordId: "recOne",
      reason: "INVALID_SCHEDULED_DATE",
      rawValue: "10/01/2026",
    }]);
    await expect(runInspectionPortalDatesBackfill({ ...input, mode: "apply" }))
      .rejects.toThrow("INSPECTION_PORTAL_DATES_BACKFILL_HAS_FAILURES");
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("skips the whole record when EMMA: Ważny do is invalid", async () => {
    const updateMany = vi.fn();
    const row = stored("db-error", "recError", "2", "2025-01-01", "2025-02-01");
    const prisma = fixturePrisma([row], updateMany);

    const report = await runInspectionPortalDatesBackfill({
      prisma: prisma as never,
      airtable: { fetchAllRecords: async () => [
        record("recError", "2", "2026-10-01", "#ERROR!"),
      ] } as never,
      mode: "apply",
      log: () => undefined,
    });

    expect(report.skipped).toEqual([{
      businessNumber: "2",
      sourceRecordId: "recError",
      reason: "SKIPPED_INVALID_VALID_UNTIL",
      rawValue: "#ERROR!",
    }]);
    expect(report.summary).toMatchObject({
      UPDATED: 0,
      SKIPPED_INVALID_VALID_UNTIL: 1,
      FAILED: 0,
    });
    expect(updateMany).not.toHaveBeenCalled();
    expect(row.inspectionScheduledDate).toEqual(new Date("2025-01-01T00:00:00.000Z"));
    expect(row.inspectionValidUntil).toEqual(new Date("2025-02-01T00:00:00.000Z"));
  });

  it("skips a missing Airtable record without changing or deactivating TrackedCase", async () => {
    const updateMany = vi.fn();
    const row = stored("db-missing", "recMissing", "3", "2025-03-01", "2025-04-01");
    const prisma = fixturePrisma([row], updateMany);

    const report = await runInspectionPortalDatesBackfill({
      prisma: prisma as never,
      airtable: { fetchAllRecords: async () => [] } as never,
      mode: "apply",
      log: () => undefined,
    });

    expect(report.skipped).toEqual([{
      businessNumber: "3",
      sourceRecordId: "recMissing",
      reason: "SKIPPED_AIRTABLE_RECORD_MISSING",
    }]);
    expect(report.summary).toMatchObject({
      UPDATED: 0,
      SKIPPED_AIRTABLE_RECORD_MISSING: 1,
      FAILED: 0,
    });
    expect(updateMany).not.toHaveBeenCalled();
    expect(row).toMatchObject({
      active: true,
      inspectionScheduledDate: new Date("2025-03-01T00:00:00.000Z"),
      inspectionValidUntil: new Date("2025-04-01T00:00:00.000Z"),
    });
  });

  it("applies a valid record while skipping invalid and missing records in a mixed batch", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const prisma = fixturePrisma([
      stored("db-valid", "recValid", "10", null, null),
      stored("db-error", "recError", "11", "2025-01-01", "2025-02-01"),
      stored("db-missing", "recMissing", "12", "2025-03-01", "2025-04-01"),
    ], updateMany);

    const report = await runInspectionPortalDatesBackfill({
      prisma: prisma as never,
      airtable: { fetchAllRecords: async () => [
        record("recValid", "10", "2026-10-01", "01-10-2027"),
        record("recError", "11", "2026-10-02", "#ERROR!"),
      ] } as never,
      mode: "apply",
      log: () => undefined,
    });

    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "db-valid", active: true }),
      data: {
        inspectionScheduledDate: new Date("2026-10-01T00:00:00.000Z"),
        inspectionValidUntil: new Date("2027-10-01T00:00:00.000Z"),
      },
    }));
    expect(report.summary).toMatchObject({
      checked: 3,
      UPDATED: 1,
      SKIPPED_INVALID_VALID_UNTIL: 1,
      SKIPPED_AIRTABLE_RECORD_MISSING: 1,
      UNCHANGED: 0,
      FAILED: 0,
    });
    expect(report.skipped).toEqual([
      expect.objectContaining({
        businessNumber: "11",
        sourceRecordId: "recError",
        reason: "SKIPPED_INVALID_VALID_UNTIL",
      }),
      {
        businessNumber: "12",
        sourceRecordId: "recMissing",
        reason: "SKIPPED_AIRTABLE_RECORD_MISSING",
      },
    ]);
  });

  it("splits a large apply into short transactions and reports progress", async () => {
    const rows = Array.from({ length: 501 }, (_, index) =>
      stored(`db-${index}`, `rec-${index}`, String(index), null, null));
    const records = Array.from({ length: 501 }, (_, index) =>
      record(`rec-${index}`, String(index), "2026-10-01", "01-10-2027"));
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const prisma = fixturePrisma(rows, updateMany);
    const logs: string[] = [];

    const report = await runInspectionPortalDatesBackfill({
      prisma: prisma as never,
      airtable: { fetchAllRecords: async () => records } as never,
      mode: "apply",
      log: (line) => logs.push(line),
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
    expect(updateMany).toHaveBeenCalledTimes(501);
    expect(logs).toContain("APPLY batch 1/3");
    expect(logs).toContain("APPLY batch 2/3");
    expect(logs).toContain("APPLY batch 3/3");
    expect(report.summary).toMatchObject({ UPDATED: 501, FAILED: 0 });
    expect(report.apply).toEqual({
      planned: 501,
      committed: 501,
      failed: 0,
      notAttempted: 0,
      completedBatches: 3,
      totalBatches: 3,
      failedBatch: null,
      durationMs: expect.any(Number),
    });
  });

  it("keeps committed batches after a later batch fails and safely resumes on rerun", async () => {
    const rows = Array.from({ length: 501 }, (_, index) =>
      stored(`db-${index}`, `rec-${index}`, String(index), null, null));
    const records = Array.from({ length: 501 }, (_, index) =>
      record(`rec-${index}`, String(index), "2026-10-01", "01-10-2027"));
    const prisma = statefulPrisma(rows, 2);
    const firstLogs: string[] = [];

    let applyError: InspectionPortalDatesBackfillApplyError | undefined;
    try {
      await runInspectionPortalDatesBackfill({
        prisma: prisma as never,
        airtable: { fetchAllRecords: async () => records } as never,
        mode: "apply",
        log: (line) => firstLogs.push(line),
      });
    } catch (error: unknown) {
      if (error instanceof InspectionPortalDatesBackfillApplyError) applyError = error;
      else throw error;
    }

    expect(applyError?.report.apply).toEqual({
      planned: 501,
      committed: 250,
      failed: 250,
      notAttempted: 1,
      completedBatches: 1,
      totalBatches: 3,
      failedBatch: 2,
      durationMs: expect.any(Number),
    });
    expect(applyError?.report.summary).toMatchObject({ UPDATED: 250, FAILED: 250 });
    expect(firstLogs).toContain("APPLY batch 1/3 committed=250");
    expect(firstLogs).toContain("APPLY batch 2/3 FAILED: simulated batch failure");
    expect(rows.slice(0, 250).every((row) =>
      row.inspectionScheduledDate?.toISOString() === "2026-10-01T00:00:00.000Z")).toBe(true);
    expect(rows.slice(250).every((row) => row.inspectionScheduledDate === null)).toBe(true);

    const rerun = await runInspectionPortalDatesBackfill({
      prisma: prisma as never,
      airtable: { fetchAllRecords: async () => records } as never,
      mode: "apply",
      log: () => undefined,
    });

    expect(rerun.summary).toMatchObject({
      UPDATED: 251,
      UNCHANGED: 250,
      FAILED: 0,
    });
    expect(rerun.apply).toMatchObject({
      planned: 251,
      committed: 251,
      notAttempted: 0,
    });
    expect(rows.every((row) =>
      row.inspectionValidUntil?.toISOString() === "2027-10-01T00:00:00.000Z")).toBe(true);
  });

  it("targets exactly one active inspection and verifies it after apply", async () => {
    const target = stored("db-27190", "rec2QXkBuCSLO6oeB", "27190", null, null);
    const other = stored("db-other", "recOther", "27191", null, null);
    const prisma = statefulPrisma([target, other], Number.MAX_SAFE_INTEGER);
    const logs: string[] = [];

    const report = await runInspectionPortalDatesBackfill({
      prisma: prisma as never,
      airtable: { fetchAllRecords: async () => [
        record("rec2QXkBuCSLO6oeB", "27190", "2026-09-30", "01-09-2027"),
        record("recOther", "27191", "2026-10-02", "02-10-2027"),
      ] } as never,
      mode: "apply",
      target: { sourceRecordId: "rec2QXkBuCSLO6oeB" },
      log: (line) => logs.push(line),
    });

    expect(prisma.trackedCase.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        caseType: "INSPECTION",
        active: true,
        airtableRecordId: "rec2QXkBuCSLO6oeB",
      },
    }));
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(target).toMatchObject({
      inspectionScheduledDate: new Date("2026-09-30T00:00:00.000Z"),
      inspectionValidUntil: new Date("2027-09-01T00:00:00.000Z"),
    });
    expect(other).toMatchObject({
      inspectionScheduledDate: null,
      inspectionValidUntil: null,
    });
    expect(report.verification).toEqual({
      businessNumber: "27190",
      sourceRecordId: "rec2QXkBuCSLO6oeB",
      inspectionScheduledDate: new Date("2026-09-30T00:00:00.000Z"),
      inspectionValidUntil: new Date("2027-09-01T00:00:00.000Z"),
    });
    expect(report.apply).toMatchObject({
      committed: 1,
      failed: 0,
      durationMs: expect.any(Number),
    });
    expect(logs.some((line) =>
      line.startsWith("INSPECTION_PORTAL_DATES_BACKFILL_VERIFICATION "))).toBe(true);
  });
});

function fixturePrisma(rows: ReturnType<typeof stored>[], updateMany: ReturnType<typeof vi.fn>) {
  const transactionClient = { trackedCase: { updateMany } };
  return {
    trackedCase: { findMany: vi.fn(async () => rows) },
    $transaction: vi.fn(async (operation: (tx: typeof transactionClient) => Promise<void>) =>
      operation(transactionClient)),
  };
}

function statefulPrisma(rows: ReturnType<typeof stored>[], failTransactionNumber: number) {
  let transactionNumber = 0;
  const updateMany = vi.fn(async (args: {
    where: {
      id: string;
      active: boolean;
      inspectionScheduledDate: Date | null;
      inspectionValidUntil: Date | null;
    };
    data: {
      inspectionScheduledDate: Date | null;
      inspectionValidUntil: Date | null;
    };
  }) => {
    const row = rows.find((candidate) =>
      candidate.id === args.where.id
      && candidate.active === args.where.active
      && sameDate(candidate.inspectionScheduledDate, args.where.inspectionScheduledDate)
      && sameDate(candidate.inspectionValidUntil, args.where.inspectionValidUntil));
    if (!row) return { count: 0 };
    row.inspectionScheduledDate = args.data.inspectionScheduledDate;
    row.inspectionValidUntil = args.data.inspectionValidUntil;
    return { count: 1 };
  });
  const transactionClient = { trackedCase: { updateMany } };
  return {
    trackedCase: {
      findMany: vi.fn(async (args?: {
        where?: { businessNumber?: string; airtableRecordId?: string };
      }) => rows.filter((row) =>
        (!args?.where?.businessNumber || row.businessNumber === args.where.businessNumber)
        && (!args?.where?.airtableRecordId
          || row.airtableRecordId === args.where.airtableRecordId))),
      findUnique: vi.fn(async (args: { where: { id: string } }) =>
        rows.find((row) => row.id === args.where.id) ?? null),
    },
    $transaction: vi.fn(async (operation: (tx: typeof transactionClient) => Promise<void>) => {
      transactionNumber += 1;
      if (transactionNumber === failTransactionNumber) throw new Error("simulated batch failure");
      return operation(transactionClient);
    }),
  };
}

function sameDate(left: Date | null, right: Date | null) {
  return left?.getTime() === right?.getTime();
}

function stored(
  id: string,
  airtableRecordId: string,
  businessNumber: string,
  scheduled: string | null,
  validUntil: string | null,
) {
  return {
    id,
    airtableRecordId,
    businessNumber,
    active: true,
    inspectionScheduledDate: scheduled ? new Date(`${scheduled}T00:00:00.000Z`) : null,
    inspectionValidUntil: validUntil ? new Date(`${validUntil}T00:00:00.000Z`) : null,
  };
}

function record(
  id: string,
  businessNumber: string,
  scheduled: string | undefined,
  validUntil: string | undefined,
) {
  return {
    id,
    createdTime: "2026-08-01T00:00:00.000Z",
    fields: {
      [INSPECTION_FIELDS.businessNumber]: businessNumber,
      ...(scheduled === undefined ? {} : { [INSPECTION_FIELDS.scheduledDate]: scheduled }),
      ...(validUntil === undefined ? {} : { [INSPECTION_FIELDS.emmaValidUntil]: validUntil }),
    },
  };
}
