import { describe, expect, it, vi } from "vitest";
import {
  AIRTABLE_TABLE_IDS,
  HOSPITAL_FIELDS,
  SERVICE_ORDER_FIELDS,
} from "../airtable/field-ids.js";
import type { AirtableIncrementalSource, AirtableRecord } from "../airtable/types.js";
import {
  runCaseHospitalScopeRepair,
  type CaseHospitalScopeRepairStore,
} from "./case-hospital-scope-repair.js";

describe("case hospital scope repair", () => {
  it("repairs scopes without touching events, deliveries or mailing", async () => {
    const store = repairStore();
    const records: AirtableRecord[] = [
      airtableRecord("repair-1", ["recHospitalH1"]),
      airtableRecord("repair-2", []),
    ];
    const hospitals: AirtableRecord[] = [
      hospitalRecord("recHospitalH1", ["recInspection1"]),
    ];
    const airtable = {
      fetchAllRecords: vi.fn(async (tableId: string) =>
        tableId === AIRTABLE_TABLE_IDS.hospitals ? hospitals : records),
    } as unknown as AirtableIncrementalSource;
    const log = vi.fn();
    const result = await runCaseHospitalScopeRepair({ store, airtable, log });

    expect(result.skipped).toBe(false);
    expect(store.appliedScopes).toEqual(new Map([
      ["repair-1", "recHospitalH1"], ["repair-2", null],
    ]));
    expect(store.inspectionIndex.get("recInspection1")).toEqual(
      new Set(["recHospitalH1"]),
    );
    expect(store.markCompleted).toHaveBeenCalledOnce();
    expect(result.stats).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityType: "SERVICE_ORDER", repaired: 1 }),
      expect.objectContaining({ entityType: "INSPECTION", ambiguous: 0 }),
    ]));
    expect(log).toHaveBeenCalledWith(expect.stringContaining(
      "CASE_HOSPITAL_SCOPE_REPAIR version=V2 entityType=SERVICE_ORDER",
    ));
    expect(airtable.fetchAllRecords).toHaveBeenNthCalledWith(
      1,
      AIRTABLE_TABLE_IDS.serviceOrders,
      [SERVICE_ORDER_FIELDS.sourceHospitalLink],
    );
    expect(airtable.fetchAllRecords).toHaveBeenNthCalledWith(
      2,
      AIRTABLE_TABLE_IDS.hospitals,
      [HOSPITAL_FIELDS.inspectionLinks],
    );
    // The repair API has no CommunicationEvent/Delivery/sender dependency.
    expect(Object.keys(store)).not.toContain("communicationEvent");
    expect(Object.keys(store)).not.toContain("communicationDelivery");
  });

  it("is restart-safe and skips after its persistent checkpoint", async () => {
    const store = repairStore();
    store.isCompleted = vi.fn(async () => true);
    const airtable = { fetchAllRecords: vi.fn() } as unknown as AirtableIncrementalSource;
    const result = await runCaseHospitalScopeRepair({ store, airtable });
    expect(result).toEqual({ skipped: true, stats: [] });
    expect(airtable.fetchAllRecords).not.toHaveBeenCalled();
    expect(store.markCompleted).not.toHaveBeenCalled();
  });

  it("writes the V2 checkpoint only after both entity repairs succeed", async () => {
    const store = repairStore();
    store.applyInspectionScopes = vi.fn(async () => {
      throw new Error("database unavailable");
    });
    const airtable = {
      fetchAllRecords: vi.fn(async (tableId: string) => tableId === AIRTABLE_TABLE_IDS.hospitals
        ? [hospitalRecord("H1", ["inspection-1"])]
        : [airtableRecord("repair-1", ["H1"])]),
    } as unknown as AirtableIncrementalSource;

    await expect(runCaseHospitalScopeRepair({ store, airtable })).rejects.toThrow(
      "database unavailable",
    );
    expect(store.markCompleted).not.toHaveBeenCalled();
  });

});

function repairStore(): CaseHospitalScopeRepairStore & {
  appliedScopes: Map<string, string | null>;
  inspectionIndex: Map<string, ReadonlySet<string>>;
  markCompleted: ReturnType<typeof vi.fn>;
} {
  const state = {
    appliedScopes: new Map<string, string | null>(),
    inspectionIndex: new Map<string, ReadonlySet<string>>(),
    markCompleted: vi.fn(async () => undefined),
    isCompleted: vi.fn(async () => false),
    applyServiceOrderScopes: vi.fn(async (scopes: ReadonlyMap<string, string | null>) => {
      state.appliedScopes.clear();
      for (const [recordId, hospitalId] of scopes) {
        state.appliedScopes.set(recordId, hospitalId);
      }
      return { scanned: 2, repaired: 1, unchanged: 1, stillUnscoped: 1 };
    }),
    applyInspectionScopes: vi.fn(async (index: ReadonlyMap<string, ReadonlySet<string>>) => {
      state.inspectionIndex.clear();
      for (const [recordId, hospitalIds] of index) {
        state.inspectionIndex.set(recordId, hospitalIds);
      }
      return {
        scanned: 1, repaired: 1, unchanged: 0, stillUnscoped: 0, ambiguous: 0,
      };
    }),
  };
  return state;
}

function hospitalRecord(id: string, inspections: string[]): AirtableRecord {
  return {
    id,
    createdTime: "2026-08-14T00:00:00.000Z",
    fields: { [HOSPITAL_FIELDS.inspectionLinks]: inspections },
  };
}

function airtableRecord(id: string, hospitals: string[]): AirtableRecord {
  return {
    id,
    createdTime: "2026-08-14T00:00:00.000Z",
    fields: { [SERVICE_ORDER_FIELDS.sourceHospitalLink]: hospitals },
  };
}
