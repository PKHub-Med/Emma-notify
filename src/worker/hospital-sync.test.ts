import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../generated/prisma/client.js";
import { HOSPITAL_FIELDS } from "../airtable/field-ids.js";
import { mapHospital } from "../airtable/hospital.js";
import type { AirtableRecord, AirtableRecordSource } from "../airtable/types.js";
import {
  buildInspectionHospitalScopeIndex,
  runHospitalSync,
  synchronizeInspectionHospitalScopes,
  type HospitalSyncStore,
} from "./hospital-sync.js";

describe("Hospital -> Inspection canonical scope", () => {
  it.each([
    ["WUM", "WUM"],
    ["", null],
    [null, null],
    [undefined, null],
    [0, null],
    ["0", null],
  ])("normalizes the Airtable hospital short name %j", (input, expected) => {
    const mapped = mapHospital({
      id: "recHospital",
      createdTime: "2026-09-27T00:00:00.000Z",
      fields: { [HOSPITAL_FIELDS.shortName]: input },
    });

    expect(mapped.shortName).toBe(expected);
  });

  it("preserves existing scope when evidence is missing, ambiguous or conflicting", async () => {
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
    const createCommunicationEvent = vi.fn();
    const prisma = {
      trackedCase: { findMany: vi.fn(async () => rows), update },
      trackedDevice: { findMany: vi.fn(async () => []) },
      communicationEvent: { create: createCommunicationEvent },
    } as unknown as PrismaClient;
    const log = vi.fn();

    const stats = await synchronizeInspectionHospitalScopes(prisma, index, log);

    expect(stats).toEqual({
      scanned: 4, repaired: 0, unchanged: 4, stillUnscoped: 3, ambiguous: 2,
    });
    expect(update).not.toHaveBeenCalled();
    expect(createCommunicationEvent).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining(
      "INSPECTION_HOSPITAL_SCOPE_MISSING",
    ));
    expect(log).toHaveBeenCalledWith(expect.stringContaining(
      "INSPECTION_HOSPITAL_SCOPE_AMBIGUOUS",
    ));
  });

  it("limits a scoped repair query to the explicit Inspection Record IDs", async () => {
    const findMany = vi.fn(async () => []);
    const prisma = {
      trackedCase: { findMany, update: vi.fn() },
      trackedDevice: { findMany: vi.fn(async () => []) },
    } as unknown as PrismaClient;

    await synchronizeInspectionHospitalScopes(
      prisma,
      new Map(),
      vi.fn(),
      ["inspection-A", "inspection-A"],
    );

    expect(findMany).toHaveBeenCalledWith({
      where: {
        caseType: "INSPECTION",
        airtableRecordId: { in: ["inspection-A"] },
      },
      select: {
        id: true,
        airtableRecordId: true,
        sourceHospitalRecordId: true,
        devices: { select: { deviceAirtableId: true } },
      },
    });
  });

  it("uses one verified Device hospital when no direct relation or scope exists", async () => {
    const update = vi.fn(async () => ({}));
    const prisma = {
      trackedCase: { findMany: vi.fn(async () => [{
        ...caseRow("1", "inspection-device", null),
        devices: [{ deviceAirtableId: "device-1" }],
      }]), update },
      trackedDevice: { findMany: vi.fn(async () => [{
        airtableRecordId: "device-1", sourceHospitalRecordId: "H1",
      }]) },
    } as unknown as PrismaClient;

    const stats = await synchronizeInspectionHospitalScopes(prisma, new Map(), vi.fn());

    expect(stats.repaired).toBe(1);
    expect(update).toHaveBeenCalledWith({
      where: { id: "1" }, data: { sourceHospitalRecordId: "H1" },
    });
  });

  it("does not choose between conflicting direct and Device hospitals", async () => {
    const update = vi.fn(async () => ({}));
    const prisma = {
      trackedCase: { findMany: vi.fn(async () => [{
        ...caseRow("1", "inspection-conflict", null),
        devices: [{ deviceAirtableId: "device-1" }],
      }]), update },
      trackedDevice: { findMany: vi.fn(async () => [{
        airtableRecordId: "device-1", sourceHospitalRecordId: "H2",
      }]) },
    } as unknown as PrismaClient;
    const direct = new Map([["inspection-conflict", new Set(["H1"])]]);

    const stats = await synchronizeInspectionHospitalScopes(prisma, direct, vi.fn());

    expect(stats.ambiguous).toBe(1);
    expect(update).not.toHaveBeenCalled();
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
