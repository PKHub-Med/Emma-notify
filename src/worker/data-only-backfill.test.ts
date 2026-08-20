import { describe, expect, it, vi } from "vitest";
import { AIRTABLE_TABLE_IDS } from "../airtable/field-ids.js";
import { runDataOnlyBackfill } from "./data-only-backfill.js";

describe("data-only backfill", () => {
  it("reports source records missing from Airtable without deleting history", async () => {
    const findMany = vi.fn(async () => [{ airtableRecordId: "ghost" }]);
    const prisma = {
      trackedHospital: { findMany }, trackedDevice: { findMany },
      trackedCase: { findMany }, trackedTask: { findMany },
    };
    const result = await runDataOnlyBackfill({
      prisma: prisma as never,
      airtable: { fetchAllRecords: async () => [] } as never,
      mode: "dry-run", log: () => undefined,
    });
    expect(result.missingFromAirtable).toEqual({
      hospitals: 1, devices: 1, serviceOrders: 1, inspections: 1, tasks: 1,
    });
  });

  it("is read-only in dry-run mode and reports every entity", async () => {
    const records = new Map(Object.values(AIRTABLE_TABLE_IDS).map((tableId) =>
      [tableId, [{ id: `rec-${tableId}`, createdTime: "2026-08-20T10:00:00Z", fields: {} }]]));
    const fetchAllRecords = vi.fn(async (tableId: string) => records.get(tableId) ?? []);
    const write = vi.fn(() => { throw new Error("unexpected write"); });
    const findMany = vi.fn(async () => []);
    const prisma = {
      trackedHospital: { findMany, create: write, update: write, upsert: write },
      trackedDevice: { findMany, create: write, update: write, upsert: write },
      trackedCase: { findMany, create: write, update: write, upsert: write },
      trackedTask: { findMany, create: write, update: write, upsert: write },
    };
    const result = await runDataOnlyBackfill({
      prisma: prisma as never,
      airtable: { fetchAllRecords } as never,
      mode: "dry-run",
      log: () => undefined,
    });
    expect(fetchAllRecords).toHaveBeenCalledTimes(6);
    expect(result.airtable).toMatchObject({ contacts: 1, hospitals: 1, devices: 1,
      serviceOrders: 1, inspections: 1, tasks: 1 });
    expect(write).not.toHaveBeenCalled();
  });

  it("keeps every forbidden table unchanged in apply mode", async () => {
    const count = vi.fn(async () => 7);
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const prisma = {
      trackedHospital: { findMany: async () => [], updateMany },
      trackedDevice: { findMany: async () => [], updateMany },
      trackedCase: { findMany: async () => [], updateMany },
      trackedTask: { findMany: async () => [], updateMany },
      communicationEvent: { count }, communicationDelivery: { count }, caseEvent: { count },
      digest: { count }, notificationBuffer: { count }, bufferItem: { count },
      portalAccessGrant: { count }, communicationAsset: { count },
    };
    const forbiddenWrite = vi.fn(() => { throw new Error("forbidden write"); });
    const stores = {
      baseline: { upsertCase: forbiddenWrite, syncRecipients: forbiddenWrite },
      hospital: { upsert: forbiddenWrite, synchronizeInspectionScopes: async () => ({
        scanned: 0, repaired: 0, unchanged: 0, stillUnscoped: 0, ambiguous: 0,
      }) },
      device: { upsert: forbiddenWrite }, task: { upsertTask: forbiddenWrite },
      communication: { observe: forbiddenWrite },
    };
    const result = await runDataOnlyBackfill({
      prisma: prisma as never,
      airtable: { fetchAllRecords: async () => [] } as never,
      stores: stores as never,
      mode: "apply",
      log: () => undefined,
    });
    expect(forbiddenWrite).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledTimes(5);
    expect(updateMany.mock.calls.slice(2).every((call) =>
      (call[0] as { data: { active: boolean } }).data.active === false)).toBe(true);
    expect(result).toMatchObject({ safetyDeltas: {
      communicationEvent: 0, communicationDelivery: 0, caseEvent: 0, digest: 0,
      notificationBuffer: 0, bufferItem: 0, portalAccessGrant: 0, communicationAsset: 0,
    } });
  });

  it("runs the production APPLY mutation phase inside one serializable transaction", async () => {
    const count = vi.fn(async () => 0);
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const transactionClient = {
      trackedHospital: { updateMany }, trackedDevice: { updateMany },
      trackedCase: { findMany: async () => [], updateMany }, trackedTask: { updateMany },
      communicationEvent: { count }, communicationDelivery: { count }, caseEvent: { count },
      digest: { count }, notificationBuffer: { count }, bufferItem: { count },
      portalAccessGrant: { count }, communicationAsset: { count },
    };
    const $transaction = vi.fn(async (operation: (tx: typeof transactionClient) => Promise<unknown>) =>
      operation(transactionClient));
    const prisma = {
      trackedHospital: { findMany: async () => [] }, trackedDevice: { findMany: async () => [] },
      trackedCase: { findMany: async () => [] }, trackedTask: { findMany: async () => [] },
      $transaction,
    };
    await runDataOnlyBackfill({ prisma: prisma as never,
      airtable: { fetchAllRecords: async () => [] } as never,
      mode: "apply", log: () => undefined });
    expect($transaction).toHaveBeenCalledTimes(1);
    expect($transaction.mock.calls[0]?.[1]).toMatchObject({ timeout: 120_000 });
    expect(updateMany).toHaveBeenCalledTimes(5);
  });

  it("applies a six-entity fixture with no communication-side effects", async () => {
    const records = new Map(Object.values(AIRTABLE_TABLE_IDS).map((tableId) =>
      [tableId, [{ id: `rec-${tableId}`, createdTime: "2026-08-20T10:00:00Z", fields: {} }]]));
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const count = vi.fn(async () => 11);
    const prisma = {
      trackedHospital: { findMany: async () => [], updateMany },
      trackedDevice: { findMany: async () => [], updateMany },
      trackedCase: { findMany: async () => [], updateMany },
      trackedTask: { findMany: async () => [], updateMany },
      communicationEvent: { count }, communicationDelivery: { count }, caseEvent: { count },
      digest: { count }, notificationBuffer: { count }, bufferItem: { count },
      portalAccessGrant: { count }, communicationAsset: { count },
    };
    const baseline = { upsertCase: vi.fn(async (item: { airtableRecordId: string }) => item.airtableRecordId),
      syncRecipients: vi.fn(async () => undefined) };
    const hospital = { upsert: vi.fn(async () => undefined),
      synchronizeInspectionScopes: vi.fn(async () => ({ scanned: 1, repaired: 0,
        unchanged: 1, stillUnscoped: 0, ambiguous: 0 })) };
    const device = { upsert: vi.fn(async () => undefined) };
    const task = { upsertTask: vi.fn(async () => "FIRST_SEEN") };
    const signatures = new Map<string, string>();
    const outcomes: string[] = [];
    const communication = { observe: vi.fn(async (observation: { sourceRecordId: string; signature: string }) => {
      const unchanged = signatures.get(observation.sourceRecordId) === observation.signature;
      signatures.set(observation.sourceRecordId, observation.signature);
      const outcome = unchanged ? "UNCHANGED" : "SUPPRESSED";
      outcomes.push(outcome);
      return { outcome, revision: 0 };
    }) };
    const input = {
      prisma: prisma as never,
      airtable: { fetchAllRecords: async (tableId: string) => records.get(tableId) ?? [] } as never,
      stores: { baseline, hospital, device, task, communication } as never,
      mode: "apply" as const, log: () => undefined,
    };
    const result = await runDataOnlyBackfill(input);
    expect(baseline.upsertCase).toHaveBeenCalledTimes(2);
    expect(hospital.upsert).toHaveBeenCalledTimes(1);
    expect(device.upsert).toHaveBeenCalledTimes(1);
    expect(task.upsertTask).toHaveBeenCalledTimes(1);
    expect(result.safetyDeltas).toEqual({ communicationEvent: 0, communicationDelivery: 0,
      caseEvent: 0, digest: 0, notificationBuffer: 0, bufferItem: 0,
      portalAccessGrant: 0, communicationAsset: 0 });
    await runDataOnlyBackfill(input);
    expect(outcomes).toEqual(["SUPPRESSED", "SUPPRESSED", "UNCHANGED", "UNCHANGED"]);
    expect(count).toHaveBeenCalledTimes(32);
  });
});
