import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../generated/prisma/client.js";
import { HOSPITAL_FIELDS } from "../airtable/field-ids.js";
import type { AirtableRecord, AirtableRecordSource } from "../airtable/types.js";
import {
  buildInspectionHospitalScopeIndex,
  runHospitalSync,
  synchronizeInspectionHospitalScopes,
  type HospitalSyncStore,
} from "./hospital-sync.js";

describe("Hospital -> Inspection canonical scope", () => {
  it("builds a reverse Record ID map and never chooses among two Hospitals", async () => {
    const index = buildInspectionHospitalScopeIndex([
      mappedHospital("H1", ["inspection-change", "inspection-same", "inspection-ambiguous"]),
      mappedHospital("H2", ["inspection-ambiguous"]),
    ]);
    const rows = [
      caseRow("1", "inspection-change", "H2"),
      caseRow("2", "inspection-same", "H1"),
      caseRow("3", "inspection-missing", "H2"),
      caseRow("4", "inspection-ambiguous", "H2"),
    ];
    const update = vi.fn(async () => ({}));
    const prisma = {
      trackedCase: { findMany: vi.fn(async () => rows), update },
    } as unknown as PrismaClient;
    const log = vi.fn();

    const stats = await synchronizeInspectionHospitalScopes(prisma, index, log);

    expect(stats).toEqual({
      scanned: 4, repaired: 3, unchanged: 1, stillUnscoped: 2, ambiguous: 1,
    });
    expect(update).toHaveBeenCalledTimes(3);
    expect(update).toHaveBeenCalledWith({
      where: { id: "1" }, data: { sourceHospitalRecordId: "H1" },
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: "3" }, data: { sourceHospitalRecordId: null },
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: "4" }, data: { sourceHospitalRecordId: null },
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining(
      "INSPECTION_HOSPITAL_SCOPE_MISSING",
    ));
    expect(log).toHaveBeenCalledWith(expect.stringContaining(
      "INSPECTION_HOSPITAL_SCOPE_AMBIGUOUS",
    ));
  });

  it("uses one paginated Hospital list operation for a 26k-like relation set", async () => {
    const records = Array.from({ length: 362 }, (_, hospitalIndex) =>
      hospitalRecord(`hospital-${hospitalIndex}`, Array.from(
        { length: 72 },
        (_, inspectionIndex) => `recInspection${hospitalIndex}_${inspectionIndex}`,
      )));
    let metrics = { requestsMade: 0, pagesFetched: 0 };
    const airtable = {
      fetchAllRecords: vi.fn(async () => {
        metrics = { requestsMade: 4, pagesFetched: 4 };
        return records;
      }),
      getRequestMetrics: () => metrics,
    } as AirtableRecordSource & { getRequestMetrics(): typeof metrics };
    const store = hospitalStore();

    const stats = await runHospitalSync({ airtable, store });

    expect(airtable.fetchAllRecords).toHaveBeenCalledOnce();
    expect(stats).toMatchObject({ recordsFetched: 362, pagesFetched: 4, requestsMade: 4 });
    expect(store.synchronizeInspectionScopes).toHaveBeenCalledOnce();
    const index = vi.mocked(store.synchronizeInspectionScopes).mock.calls[0]![0];
    expect(index.size).toBe(362 * 72);
  });
});

function hospitalStore(): HospitalSyncStore {
  return {
    upsert: vi.fn(async () => undefined),
    synchronizeInspectionScopes: vi.fn(async () => ({
      scanned: 0, repaired: 0, unchanged: 0, stillUnscoped: 0, ambiguous: 0,
    })),
    markRunning: vi.fn(async () => undefined),
    markSuccessful: vi.fn(async () => undefined),
    markFailed: vi.fn(async () => undefined),
  };
}

function mappedHospital(airtableRecordId: string, linkedInspectionRecordIds: string[]) {
  return {
    airtableRecordId,
    shortName: null,
    name: null,
    address: null,
    linkedInspectionRecordIds,
  };
}

function hospitalRecord(id: string, inspections: string[]): AirtableRecord {
  return {
    id,
    createdTime: "2026-08-14T00:00:00.000Z",
    fields: { [HOSPITAL_FIELDS.inspectionLinks]: inspections },
  };
}

function caseRow(id: string, airtableRecordId: string, sourceHospitalRecordId: string | null) {
  return { id, airtableRecordId, sourceHospitalRecordId };
}
