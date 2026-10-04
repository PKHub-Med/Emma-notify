import { describe, expect, it, vi } from "vitest";
import {
  AIRTABLE_TABLE_IDS,
  DEVICE_FIELDS,
  HOSPITAL_FIELDS,
  INSPECTION_FIELDS,
  SERVICE_ORDER_FIELDS,
  TASK_FIELDS,
} from "../airtable/field-ids.js";
import type { AirtableRecord } from "../airtable/types.js";
import { CaseType } from "../generated/prisma/enums.js";
import {
  parseDataOnlyBackfillArgs,
  runDataOnlyBackfill,
} from "./data-only-backfill.js";

describe("data-only backfill", () => {
  it("parses an optional Hospital scope", () => {
    expect(parseDataOnlyBackfillArgs([
      "--dry-run", "--hospital", "reco9tm32STY296kc",
    ])).toEqual({ mode: "dry-run", hospitalRecordId: "reco9tm32STY296kc" });
    expect(() => parseDataOnlyBackfillArgs(["--apply", "--hospital"]))
      .toThrow("--hospital requires");
  });

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
      communicationEvent: { count }, communicationEventRecipient: { count },
      communicationDelivery: { count }, communicationUnsubscribeGrant: { count },
      caseEvent: { count }, digest: { count }, accessLink: { count },
      notificationBuffer: { count }, bufferItem: { count },
      portalAccessGrant: { count }, portalRefreshRequest: { count }, communicationAsset: { count },
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
      communicationEvent: 0, communicationEventRecipient: 0, communicationDelivery: 0,
      communicationUnsubscribeGrant: 0, caseEvent: 0, digest: 0, accessLink: 0,
      notificationBuffer: 0, bufferItem: 0, portalAccessGrant: 0,
      portalRefreshRequest: 0, communicationAsset: 0,
    } });
  });

  it("runs the production APPLY mutation phase inside one serializable transaction", async () => {
    const count = vi.fn(async () => 0);
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const transactionClient = {
      trackedHospital: { updateMany }, trackedDevice: { updateMany },
      trackedCase: { findMany: async () => [], updateMany }, trackedTask: { updateMany },
      communicationEvent: { count }, communicationEventRecipient: { count },
      communicationDelivery: { count }, communicationUnsubscribeGrant: { count },
      caseEvent: { count }, digest: { count }, accessLink: { count },
      notificationBuffer: { count }, bufferItem: { count },
      portalAccessGrant: { count }, portalRefreshRequest: { count }, communicationAsset: { count },
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
    records.set(AIRTABLE_TABLE_IDS.inspections, [{
      id: "recInspectionV5", createdTime: "2026-08-20T10:00:00Z", fields: {
        [INSPECTION_FIELDS.adminStatus]: "ZAKONCZONE",
        [INSPECTION_FIELDS.emmaStatus]: "WYKONANY",
        [INSPECTION_FIELDS.heroLabel]: "SPRAWNY",
        [INSPECTION_FIELDS.heroDescription]: "Urzadzenie jest sprawne.",
        [INSPECTION_FIELDS.emmaValidUntil]: "2027-08-20",
        [INSPECTION_FIELDS.failureReason]: "Nie dotyczy",
        [INSPECTION_FIELDS.requiredAction]: "Brak",
        [INSPECTION_FIELDS.headerDateType]: "Wykonano",
        [INSPECTION_FIELDS.headerDate]: "2026-08-20",
        [INSPECTION_FIELDS.validation]: "OK",
        [INSPECTION_FIELDS.notes]: "Bez uwag",
        [INSPECTION_FIELDS.faults]: "Brak usterek",
        [INSPECTION_FIELDS.admission]: "DOPUSZCZONO",
        [INSPECTION_FIELDS.relatedRepairNumber]: 24872,
        [INSPECTION_FIELDS.deviceTagged]: "TAK",
        [INSPECTION_FIELDS.epc]: "EPC-123",
        [INSPECTION_FIELDS.productionYear]: 2024,
        [INSPECTION_FIELDS.commissionedAt]: "2024-05-10",
        [INSPECTION_FIELDS.warrantyUntil]: "2027-05-10",
        [INSPECTION_FIELDS.result]: "SPRAWNY",
      },
    }]);
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const count = vi.fn(async () => 11);
    const prisma = {
      trackedHospital: { findMany: async () => [], updateMany },
      trackedDevice: { findMany: async () => [], updateMany },
      trackedCase: { findMany: async () => [], updateMany },
      trackedTask: { findMany: async () => [], updateMany },
      communicationEvent: { count }, communicationEventRecipient: { count },
      communicationDelivery: { count }, communicationUnsubscribeGrant: { count },
      caseEvent: { count }, digest: { count }, accessLink: { count },
      notificationBuffer: { count }, bufferItem: { count },
      portalAccessGrant: { count }, portalRefreshRequest: { count }, communicationAsset: { count },
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
    expect(baseline.upsertCase).toHaveBeenCalledWith(expect.objectContaining({
      airtableRecordId: "recInspectionV5",
      currentStatus: "WYKONANY",
      inspectionAdminStatus: "ZAKONCZONE",
      inspectionHeroLabel: "SPRAWNY",
      inspectionHeroDescription: "Urzadzenie jest sprawne.",
      inspectionHeaderDateType: "Wykonano",
      inspectionValidation: "OK",
      inspectionNotes: "Bez uwag",
      inspectionFaults: "Brak usterek",
      inspectionAdmission: "DOPUSZCZONO",
      inspectionFailureReason: "Nie dotyczy",
      inspectionRequiredAction: "Brak",
      relatedRepairNumber: "24872",
      inspectionDeviceTagged: "TAK",
      inspectionDeviceEpc: "EPC-123",
      inspectionResult: "SPRAWNY",
      sourceSnapshot: expect.objectContaining({
        productionYear: "2024",
        commissionedAt: "2024-05-10",
        warrantyUntil: "2027-05-10",
      }),
    }), expect.any(Date));
    expect(hospital.upsert).toHaveBeenCalledTimes(1);
    expect(device.upsert).toHaveBeenCalledTimes(1);
    expect(task.upsertTask).toHaveBeenCalledTimes(1);
    expect(result.safetyDeltas).toEqual({ communicationEvent: 0,
      communicationEventRecipient: 0, communicationDelivery: 0,
      communicationUnsubscribeGrant: 0, caseEvent: 0, digest: 0, accessLink: 0,
      notificationBuffer: 0, bufferItem: 0, portalAccessGrant: 0,
      portalRefreshRequest: 0, communicationAsset: 0 });
    await runDataOnlyBackfill(input);
    expect(outcomes).toEqual(["SUPPRESSED", "SUPPRESSED", "UNCHANGED", "UNCHANGED"]);
    expect(count).toHaveBeenCalledTimes(48);
  });

  it("keeps a Hospital A scoped backfill isolated from every Hospital B record", async () => {
    const hospitalA = airtableRecord("recHospitalA", {
      [HOSPITAL_FIELDS.name]: "Poznań Szamarzewskiego 84",
      [HOSPITAL_FIELDS.inspectionLinks]: ["recInspectionA"],
    });
    const hospitalB = airtableRecord("recHospitalB", {
      [HOSPITAL_FIELDS.name]: "Hospital B",
      [HOSPITAL_FIELDS.inspectionLinks]: ["recInspectionB"],
    });
    const records = new Map<string, AirtableRecord[]>([
      [AIRTABLE_TABLE_IDS.hospitals, [hospitalA, hospitalB]],
      [AIRTABLE_TABLE_IDS.serviceOrders, [
        airtableRecord("service-A", {
          [SERVICE_ORDER_FIELDS.sourceHospitalLink]: ["recHospitalA"],
          [SERVICE_ORDER_FIELDS.deviceLink]: ["recDeviceA"],
        }),
        airtableRecord("service-B", {
          [SERVICE_ORDER_FIELDS.sourceHospitalLink]: ["recHospitalB"],
          [SERVICE_ORDER_FIELDS.deviceLink]: ["recDeviceB"],
        }),
      ]],
      [AIRTABLE_TABLE_IDS.tasks, [
        airtableRecord("task-A", {
          [TASK_FIELDS.sourceHospitalLink]: ["recHospitalA"],
          [TASK_FIELDS.inspectionLinks]: ["recInspectionA"],
        }),
        airtableRecord("task-B", {
          [TASK_FIELDS.sourceHospitalLink]: ["recHospitalB"],
          [TASK_FIELDS.inspectionLinks]: ["recInspectionB"],
        }),
      ]],
    ]);
    const byId = new Map<string, AirtableRecord>([
      ["recHospitalA", hospitalA],
      ["recInspectionA", airtableRecord("recInspectionA", {
        [INSPECTION_FIELDS.deviceLink]: ["recDeviceA"],
        [INSPECTION_FIELDS.emmaStatus]: "WYKONANY",
        [INSPECTION_FIELDS.validation]: "OK",
      })],
      ["recDeviceA", airtableRecord("recDeviceA", {
        [DEVICE_FIELDS.hospitalLink]: ["recHospitalA"],
      })],
    ]);
    const forbiddenMutation = vi.fn(() => {
      throw new Error("scoped backfill must not run broad mutations");
    });
    const trackedCaseFindMany = vi.fn(async (args: {
      where: { sourceHospitalRecordId?: string };
    }) => args.where.sourceHospitalRecordId
      ? [{ airtableRecordId: "recInspectionA" }]
      : [{
          caseType: CaseType.INSPECTION,
          airtableRecordId: "recInspectionA",
          sourceHospitalRecordId: null,
          devices: [],
        }]);
    const count = vi.fn(async () => 5);
    const prisma = {
      trackedHospital: { findMany: async () => [{ airtableRecordId: "recHospitalA" }], updateMany: forbiddenMutation },
      trackedDevice: { findMany: async () => [{ airtableRecordId: "recDeviceA" }], updateMany: forbiddenMutation },
      trackedCase: { findMany: trackedCaseFindMany, updateMany: forbiddenMutation },
      trackedTask: { findMany: async () => [{ airtableRecordId: "task-A" }], updateMany: forbiddenMutation },
      communicationEvent: { count }, communicationEventRecipient: { count },
      communicationDelivery: { count }, communicationUnsubscribeGrant: { count },
      caseEvent: { count }, digest: { count }, accessLink: { count },
      notificationBuffer: { count }, bufferItem: { count },
      portalAccessGrant: { count }, portalRefreshRequest: { count }, communicationAsset: { count },
    };
    const baseline = {
      upsertCase: vi.fn(async (item: { airtableRecordId: string }) => `tracked-${item.airtableRecordId}`),
      syncRecipients: vi.fn(async () => undefined),
    };
    const hospital = {
      upsert: vi.fn(async () => undefined),
      synchronizeInspectionScopes: vi.fn(async () => ({
        scanned: 1, repaired: 1, unchanged: 0, stillUnscoped: 0, ambiguous: 0,
      })),
    };
    const device = { upsert: vi.fn(async () => undefined) };
    const task = { upsertTask: vi.fn(async () => "CHANGED") };
    const communication = {
      observe: vi.fn(async (_observation: unknown, allowEvent: boolean) => ({
        outcome: allowEvent ? "CREATED" : "SUPPRESSED",
        revision: 1,
      })),
    };
    const input = {
      prisma: prisma as never,
      airtable: {
        fetchAllRecords: vi.fn(async (tableId: string) => records.get(tableId) ?? []),
        fetchRecord: vi.fn(async (_tableId: string, recordId: string) => {
          const record = byId.get(recordId);
          if (!record) throw new Error(`Unexpected scoped fetch ${recordId}`);
          return record;
        }),
      } as never,
      hospitalRecordId: "recHospitalA",
      stores: { baseline, hospital, device, task, communication } as never,
      log: () => undefined,
    };

    const dryRun = await runDataOnlyBackfill({ ...input, mode: "dry-run" });
    expect(dryRun).toMatchObject({
      scope: { hospitalRecordId: "recHospitalA", hospitalName: "Poznań Szamarzewskiego 84" },
      airtable: { hospitalInspectionLinks: 1, inspections: 1, serviceOrders: 1, devices: 1, tasks: 1 },
      inspectionScope: {
        existingInDatabase: 1,
        missingScope: 1,
        wrongScope: 0,
        resolution: { unique: 1, missing: 0, ambiguous: 0 },
      },
      deviceLinksToRepair: { cases: 2, linksToAdd: 2, linksToRemove: 0 },
    });
    expect(baseline.upsertCase).not.toHaveBeenCalled();

    const applied = await runDataOnlyBackfill({ ...input, mode: "apply" });
    const changedCaseIds = baseline.upsertCase.mock.calls.map((call) => call[0].airtableRecordId);
    expect(changedCaseIds.sort()).toEqual(["recInspectionA", "service-A"]);
    expect(changedCaseIds).not.toContain("recInspectionB");
    expect(changedCaseIds).not.toContain("service-B");
    expect(hospital.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ airtableRecordId: "recHospitalA" }),
      expect.any(Date),
    );
    expect(hospital.synchronizeInspectionScopes).toHaveBeenCalledWith(
      expect.any(Map),
      expect.any(Function),
      ["recInspectionA"],
    );
    expect(device.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ airtableRecordId: "recDeviceA" }),
      expect.any(Date),
    );
    expect(task.upsertTask).toHaveBeenCalledWith(
      expect.objectContaining({ airtableRecordId: "task-A" }),
      expect.any(Date),
    );
    expect(communication.observe.mock.calls.every((call) => call[1] === false)).toBe(true);
    expect(forbiddenMutation).not.toHaveBeenCalled();
    expect(applied).toMatchObject({ safetyDeltas: {
      communicationEvent: 0, communicationEventRecipient: 0, communicationDelivery: 0,
      communicationUnsubscribeGrant: 0, caseEvent: 0, digest: 0, accessLink: 0,
      notificationBuffer: 0, bufferItem: 0, portalAccessGrant: 0,
      portalRefreshRequest: 0, communicationAsset: 0,
    } });
  });

  it("runs scoped APPLY inside one serializable transaction", async () => {
    const hospital = airtableRecord("recHospitalA", {
      [HOSPITAL_FIELDS.name]: "Poznań Szamarzewskiego 84",
      [HOSPITAL_FIELDS.inspectionLinks]: [],
    });
    const count = vi.fn(async () => 0);
    const transactionClient = {
      trackedHospital: { upsert: vi.fn(async () => ({})) },
      trackedCase: { findMany: vi.fn(async () => []), update: vi.fn(async () => ({})) },
      communicationEvent: { count }, communicationEventRecipient: { count },
      communicationDelivery: { count }, communicationUnsubscribeGrant: { count },
      caseEvent: { count }, digest: { count }, accessLink: { count },
      notificationBuffer: { count }, bufferItem: { count },
      portalAccessGrant: { count }, portalRefreshRequest: { count }, communicationAsset: { count },
    };
    const $transaction = vi.fn(async (
      operation: (tx: typeof transactionClient) => Promise<unknown>,
    ) => operation(transactionClient));
    const prisma = {
      trackedHospital: { findMany: async () => [] },
      trackedDevice: { findMany: async () => [] },
      trackedCase: { findMany: async () => [] },
      trackedTask: { findMany: async () => [] },
      $transaction,
    };
    const airtable = {
      fetchRecord: vi.fn(async () => hospital),
      fetchAllRecords: vi.fn(async (tableId: string) =>
        tableId === AIRTABLE_TABLE_IDS.hospitals ? [hospital] : []),
    };

    await runDataOnlyBackfill({
      prisma: prisma as never,
      airtable: airtable as never,
      mode: "apply",
      hospitalRecordId: "recHospitalA",
      log: () => undefined,
    });

    expect($transaction).toHaveBeenCalledTimes(1);
    expect($transaction.mock.calls[0]?.[1]).toMatchObject({
      isolationLevel: "Serializable",
      timeout: 120_000,
    });
    expect(transactionClient.trackedHospital.upsert).toHaveBeenCalledOnce();
  });
});

function airtableRecord(id: string, fields: Record<string, unknown>): AirtableRecord {
  return { id, createdTime: "2026-10-04T00:00:00.000Z", fields };
}
