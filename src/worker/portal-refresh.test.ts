import { describe, expect, it, vi } from "vitest";
import { AirtableRequestError } from "../airtable/client.js";
import type { MappedDevice } from "../airtable/device.js";
import {
  AIRTABLE_TABLE_IDS,
  DEVICE_FIELDS,
  HOSPITAL_FIELDS,
  INSPECTION_FIELDS,
  SERVICE_ORDER_FIELDS,
  TASK_FIELDS,
} from "../airtable/field-ids.js";
import type { AirtableIncrementalSource, AirtableRecord } from "../airtable/types.js";
import type { MappedCase } from "../airtable/mappers.js";
import type { PrismaClient } from "../generated/prisma/client.js";
import { CaseType, PortalRefreshStatus } from "../generated/prisma/enums.js";
import { isPortalCaseRetained } from "../portal-access/view-model.js";
import type { CommunicationEventStore } from "./communication-event.js";
import {
  PrismaIncrementalStore,
  type IncrementalStore,
} from "./incremental-store.js";
import {
  runPortalRefreshWorkerOnce,
  PrismaPortalRefreshWorkerStore,
  type PortalRefreshWorkerStore,
  type PortalRefreshWorkItem,
} from "./portal-refresh.js";

describe("portal refresh worker", () => {
  it("claims requests atomically with a database row lock", async () => {
    let query: { strings: readonly string[] } | undefined;
    const store = new PrismaPortalRefreshWorkerStore({
      $queryRaw: async (sql: { strings: readonly string[] }) => {
        query = sql;
        return [];
      },
    } as unknown as PrismaClient);
    await expect(store.claimNext(
      new Date("2026-09-12T10:00:00Z"),
      "lease-token",
      new Date("2026-09-12T10:05:00Z"),
    )).resolves.toBeNull();
    const sql = query?.strings.join("?") ?? "";
    expect(sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(sql).toContain('status = \'RUNNING\'::"PortalRefreshStatus"');
  });

  it("deactivates stale records only inside the requesting hospital", async () => {
    const trackedCase = { updateMany: vi.fn().mockResolvedValue({ count: 1 }) };
    const trackedDevice = { updateMany: vi.fn().mockResolvedValue({ count: 1 }) };
    const trackedTask = { updateMany: vi.fn().mockResolvedValue({ count: 1 }) };
    const store = new PrismaPortalRefreshWorkerStore({
      trackedCase,
      trackedDevice,
      trackedTask,
    } as unknown as PrismaClient);

    await store.deactivateCase(CaseType.SERVICE_ORDER, "service-X", "hospital-A");
    await store.deactivateDevice("device-X", "hospital-A");
    await store.deactivateTask("task-X", "hospital-A");

    expect(trackedCase.updateMany).toHaveBeenCalledWith({
      where: {
        caseType: CaseType.SERVICE_ORDER,
        airtableRecordId: "service-X",
        sourceHospitalRecordId: "hospital-A",
        active: true,
      },
      data: { active: false },
    });
    expect(trackedDevice.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ sourceHospitalRecordId: "hospital-A" }),
    }));
    expect(trackedTask.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ sourceHospitalRecordId: "hospital-A" }),
    }));
  });

  it("refreshes scoped records by ID, applies retention and device department, and runs once", async () => {
    const requestStore = new MemoryWorkerStore({
      id: "refresh-1",
      leaseToken: "assigned-by-claim",
      sourceHospitalRecordId: "recHospitalA",
      serviceOrderRecordIds: ["service-A", "service-foreign", "service-deleted"],
      inspectionRecordIds: ["inspection-foreign"],
      deviceRecordIds: ["recDeviceA", "recDeviceForeign"],
      taskRecordIds: [],
    });
    const fetchAllRecords = vi.fn().mockResolvedValue([]);
    const fetchRecord = vi.fn(async (tableId: string, recordId: string) => {
      if (recordId === "service-deleted") {
        throw new AirtableRequestError("missing", tableId, "RECORD", 404);
      }
      if (tableId === AIRTABLE_TABLE_IDS.hospitals) return hospitalRecord([]);
      if (tableId === AIRTABLE_TABLE_IDS.serviceOrders) {
        return serviceOrderRecord(
          recordId,
          recordId === "service-foreign" ? "recHospitalB" : "recHospitalA",
        );
      }
      if (tableId === AIRTABLE_TABLE_IDS.devices) return deviceRecord(
        recordId,
        recordId === "recDeviceForeign" ? "recHospitalB" : "recHospitalA",
      );
      throw new Error(`Unexpected record ${tableId}/${recordId}`);
    });
    const airtable = { fetchAllRecords, fetchRecord } as AirtableIncrementalSource;
    const portalCases = [{ airtableRecordId: "service-A", completedAt: null as Date | null }];
    const refreshedCases: MappedCase[] = [];
    const listVisibleRepairs = () => portalCases.filter((item) =>
      isPortalCaseRetained("REPAIR", item.completedAt, new Date("2026-09-12T10:00:00Z")));
    expect(listVisibleRepairs()).toHaveLength(1);
    const incrementalStore = {
      findCase: vi.fn().mockResolvedValue(null),
      upsertCaseWithoutEvent: vi.fn(async (mapped: MappedCase) => {
        refreshedCases.push(mapped);
        const item = portalCases.find((candidate) =>
          candidate.airtableRecordId === mapped.airtableRecordId);
        if (item) item.completedAt = mapped.completedAt;
        return "tracked-service-A";
      }),
      syncRecipients: vi.fn().mockResolvedValue(undefined),
    } as unknown as IncrementalStore;
    const devices: Array<{ department: string | null; emmaDeviceStatus: string | null; repairEpc: string | null }> = [];
    const communicationStore = {
      isBaselineCompleted: vi.fn().mockResolvedValue(true),
      observe: vi.fn().mockResolvedValue({ outcome: "NO_SCENARIO", revision: 1 }),
      markBaselineCompleted: vi.fn(),
    } as unknown as CommunicationEventStore;
    const dependencies = {
      store: requestStore,
      airtable,
      incrementalStore,
      hospitalStore: noOpHospitalStore(),
      deviceStore: { async upsert(device: MappedDevice) {
        devices.push({
          department: device.department,
          emmaDeviceStatus: device.emmaDeviceStatus,
          repairEpc: device.repairEpc,
        });
      } },
      taskStore: { upsertTask: vi.fn() },
      communicationStore,
      quietMinutes: 10,
      now: () => new Date("2026-09-12T10:00:00Z"),
    };

    await expect(runPortalRefreshWorkerOnce(dependencies)).resolves.toBe(true);
    await expect(runPortalRefreshWorkerOnce(dependencies)).resolves.toBe(false);

    expect(fetchAllRecords).toHaveBeenCalledOnce();
    expect(fetchAllRecords).toHaveBeenCalledWith(
      AIRTABLE_TABLE_IDS.hospitals,
      [HOSPITAL_FIELDS.inspectionLinks],
    );
    expect(fetchRecord).toHaveBeenCalledWith(
      AIRTABLE_TABLE_IDS.serviceOrders,
      "service-A",
      expect.any(Array),
    );
    expect(portalCases).toEqual([{
      airtableRecordId: "service-A",
      completedAt: new Date("2026-04-01T00:00:00.000Z"),
    }]);
    expect(listVisibleRepairs()).toEqual([]);
    expect(refreshedCases[0]).toMatchObject({
      repairHeroLabel: "DIAGNOSTYKA",
      repairReporter: "Klinika",
      repairOfferNumber: "OF/12",
      repairDescription: "Opis naprawy",
      sourceSnapshot: { productionYear: "2021" },
    });
    expect(devices).toEqual([{
      department: "Nowy Oddział",
      emmaDeviceStatus: "NIESPRAWNY",
      repairEpc: "EPC-123",
    }]);
    expect(requestStore.status).toBe(PortalRefreshStatus.SUCCEEDED);
    expect(requestStore.claimCount).toBe(2);
    expect(requestStore.succeededCount).toBe(1);
    expect(requestStore.activeCases.has("SERVICE_ORDER:service-foreign")).toBe(false);
    expect(requestStore.activeCases.has("SERVICE_ORDER:service-deleted")).toBe(false);
    expect(requestStore.activeCases.has("INSPECTION:inspection-foreign")).toBe(false);
    expect(fetchRecord).not.toHaveBeenCalledWith(
      AIRTABLE_TABLE_IDS.inspections, "inspection-foreign", expect.any(Array),
    );
    expect(requestStore.activeDevices.has("recDeviceForeign")).toBe(false);
    expect(communicationStore.observe).toHaveBeenCalledTimes(1);
    expect(communicationStore.observe).toHaveBeenCalledWith(
      expect.any(Object),
      false,
      expect.any(Date),
    );
  });

  it("keeps a null repair production year null after a normal refresh with an empty lookup", async () => {
    const requestStore = new MemoryWorkerStore({
      id: "refresh-repair-year-empty",
      leaseToken: "assigned-by-claim",
      sourceHospitalRecordId: "recHospitalA",
      serviceOrderRecordIds: ["service-A"],
      inspectionRecordIds: [],
      deviceRecordIds: [],
      taskRecordIds: [],
    });
    let storedProductionYear: string | null = null;
    const fetchRecord = vi.fn(async (
      tableId: string,
      recordId: string,
      fieldIds: readonly string[],
    ) => {
      if (tableId === AIRTABLE_TABLE_IDS.serviceOrders) {
        expect(fieldIds).toContain(SERVICE_ORDER_FIELDS.productionYear);
        return serviceOrderRecord(recordId, "recHospitalA", null, []);
      }
      if (tableId === AIRTABLE_TABLE_IDS.hospitals) return hospitalRecord([]);
      if (tableId === AIRTABLE_TABLE_IDS.devices) {
        return deviceRecord(recordId, "recHospitalA");
      }
      throw new Error(`Unexpected record ${tableId}/${recordId}`);
    });
    const incrementalStore = {
      findCase: vi.fn().mockResolvedValue(null),
      upsertCaseWithoutEvent: vi.fn(async (mapped: MappedCase) => {
        storedProductionYear = mapped.sourceSnapshot.productionYear as string | null;
        return "tracked-service-A";
      }),
      syncRecipients: vi.fn().mockResolvedValue(undefined),
    } as unknown as IncrementalStore;

    await runPortalRefreshWorkerOnce({
      store: requestStore,
      airtable: { fetchRecord, fetchAllRecords: vi.fn(async () => []) } as AirtableIncrementalSource,
      incrementalStore,
      hospitalStore: noOpHospitalStore(),
      deviceStore: { upsert: vi.fn() },
      taskStore: { upsertTask: vi.fn() },
      communicationStore: noOpCommunicationStore(),
      quietMinutes: 10,
      now: () => new Date("2026-09-27T10:00:00.000Z"),
    });

    expect(storedProductionYear).toBeNull();
    expect(requestStore.status).toBe(PortalRefreshStatus.SUCCEEDED);
  });

  it("updates the shared hospital short name during a normal portal refresh", async () => {
    let shortName = "ABC";
    const storedShortNames: Array<string | null> = [];
    const common = {
      airtable: {
        fetchAllRecords: vi.fn(async () => []),
        fetchRecord: vi.fn(async (tableId: string) => {
          if (tableId === AIRTABLE_TABLE_IDS.hospitals) return hospitalRecord([], shortName);
          throw new Error(`Unexpected table ${tableId}`);
        }),
      } as AirtableIncrementalSource,
      incrementalStore: {} as IncrementalStore,
      hospitalStore: {
        async upsert(hospital: { shortName: string | null }) {
          storedShortNames.push(hospital.shortName);
        },
        synchronizeInspectionScopes: vi.fn(async () => ({
          scanned: 0, repaired: 0, unchanged: 0, stillUnscoped: 0, ambiguous: 0,
        })),
      },
      deviceStore: { upsert: vi.fn() },
      taskStore: { upsertTask: vi.fn() },
      communicationStore: noOpCommunicationStore(),
      quietMinutes: 10,
      now: () => new Date("2026-09-27T10:00:00.000Z"),
    };
    const work = (id: string): PortalRefreshWorkItem => ({
      id,
      leaseToken: "assigned-by-claim",
      sourceHospitalRecordId: "recHospitalA",
      serviceOrderRecordIds: [],
      inspectionRecordIds: [],
      deviceRecordIds: [],
      taskRecordIds: [],
    });

    await runPortalRefreshWorkerOnce({
      ...common,
      store: new MemoryWorkerStore(work("refresh-short-name-1")),
    });
    shortName = "XYZ";
    await runPortalRefreshWorkerOnce({
      ...common,
      store: new MemoryWorkerStore(work("refresh-short-name-2")),
    });

    expect(storedShortNames).toEqual(["ABC", "XYZ"]);
  });

  it("refreshes retention-hidden repairs and inspections so they can reappear", async () => {
    const requestStore = new MemoryWorkerStore({
      id: "refresh-retained",
      leaseToken: "assigned-by-claim",
      sourceHospitalRecordId: "recHospitalA",
      serviceOrderRecordIds: ["service-old"],
      inspectionRecordIds: ["recInspectionOld"],
      deviceRecordIds: [],
      taskRecordIds: [],
    });
    const localCases = new Map<string, { type: "REPAIR" | "INSPECTION"; date: Date | null }>([
      ["service-old", { type: "REPAIR", date: new Date("2026-05-01T00:00:00.000Z") }],
      ["recInspectionOld", { type: "INSPECTION", date: new Date("2026-05-01T00:00:00.000Z") }],
    ]);
    const now = new Date("2026-09-12T10:00:00.000Z");
    const visible = () => [...localCases.values()].filter((item) =>
      isPortalCaseRetained(item.type, item.date, now));
    expect(visible()).toHaveLength(0);

    const fetchRecord = vi.fn(async (tableId: string, recordId: string) => {
      if (tableId === AIRTABLE_TABLE_IDS.hospitals) {
        return hospitalRecord(["recInspectionOld"]);
      }
      if (tableId === AIRTABLE_TABLE_IDS.serviceOrders) {
        return serviceOrderRecord(recordId, "recHospitalA", null);
      }
      if (tableId === AIRTABLE_TABLE_IDS.inspections) {
        return inspectionRecord(recordId, "2026-09-10");
      }
      if (tableId === AIRTABLE_TABLE_IDS.devices) {
        return deviceRecord(recordId, "recHospitalA");
      }
      throw new Error(`Unexpected record ${tableId}/${recordId}`);
    });
    const incrementalStore = {
      findCase: vi.fn().mockResolvedValue(null),
      upsertCaseWithoutEvent: vi.fn(async (mapped: MappedCase) => {
        localCases.set(mapped.airtableRecordId, {
          type: mapped.caseType === CaseType.SERVICE_ORDER ? "REPAIR" : "INSPECTION",
          date: mapped.caseType === CaseType.SERVICE_ORDER
            ? mapped.completedAt
            : mapped.inspectionPerformedAt,
        });
        return `tracked-${mapped.airtableRecordId}`;
      }),
      syncRecipients: vi.fn().mockResolvedValue(undefined),
    } as unknown as IncrementalStore;
    const communicationStore = noOpCommunicationStore();

    await runPortalRefreshWorkerOnce({
      store: requestStore,
      airtable: { fetchRecord, fetchAllRecords: vi.fn(async () => []) } as AirtableIncrementalSource,
      incrementalStore,
      hospitalStore: noOpHospitalStore(),
      deviceStore: { upsert: vi.fn() },
      taskStore: { upsertTask: vi.fn() },
      communicationStore,
      quietMinutes: 10,
      now: () => now,
    });

    expect(fetchRecord).toHaveBeenCalledWith(
      AIRTABLE_TABLE_IDS.serviceOrders, "service-old", expect.any(Array),
    );
    expect(fetchRecord).toHaveBeenCalledWith(
      AIRTABLE_TABLE_IDS.inspections, "recInspectionOld", expect.any(Array),
    );
    expect(localCases.get("service-old")?.date).toBeNull();
    expect(localCases.get("recInspectionOld")?.date).toEqual(
      new Date("2026-09-10T00:00:00.000Z"),
    );
    expect(visible()).toHaveLength(2);
  });

  it("discovers an unscoped historical Inspection from Hospital links and syncs its Device", async () => {
    const inspectionId = "recInspectionHistorical";
    const deviceId = "recDeviceHistorical";
    const requestStore = new MemoryWorkerStore({
      id: "refresh-discovery",
      leaseToken: "assigned-by-claim",
      sourceHospitalRecordId: "recHospitalA",
      serviceOrderRecordIds: [],
      inspectionRecordIds: [],
      deviceRecordIds: [],
      taskRecordIds: [],
    });
    const fetchRecord = vi.fn(async (tableId: string, recordId: string) => {
      if (tableId === AIRTABLE_TABLE_IDS.hospitals) return hospitalRecord([inspectionId]);
      if (tableId === AIRTABLE_TABLE_IDS.inspections) {
        return {
          ...inspectionRecord(recordId, "2024-01-10"),
          fields: {
            ...inspectionRecord(recordId, "2024-01-10").fields,
            [INSPECTION_FIELDS.deviceLink]: [deviceId],
          },
        };
      }
      if (tableId === AIRTABLE_TABLE_IDS.devices) return deviceRecord(recordId, "recHospitalA");
      throw new Error(`Unexpected record ${tableId}/${recordId}`);
    });
    const fetchAllRecords = vi.fn(async (tableId: string) =>
      tableId === AIRTABLE_TABLE_IDS.hospitals ? [hospitalRecord([inspectionId])] : []);
    const upsertCaseWithoutEvent = vi.fn().mockResolvedValue("tracked-historical");
    const synchronizeInspectionScopes = vi.fn(async (
      _index: ReadonlyMap<string, ReadonlySet<string>>,
    ) => ({
      scanned: 1, repaired: 1, unchanged: 0, stillUnscoped: 0, ambiguous: 0,
    }));
    const deviceUpsert = vi.fn();
    const communicationStore = noOpCommunicationStore();
    const observe = vi.spyOn(communicationStore, "observe");

    await runPortalRefreshWorkerOnce({
      store: requestStore,
      airtable: { fetchRecord, fetchAllRecords } as AirtableIncrementalSource,
      incrementalStore: {
        findCase: vi.fn().mockResolvedValue(null),
        upsertCaseWithoutEvent,
        syncRecipients: vi.fn(),
      } as unknown as IncrementalStore,
      hospitalStore: { upsert: vi.fn(), synchronizeInspectionScopes },
      deviceStore: { upsert: deviceUpsert },
      taskStore: { upsertTask: vi.fn() },
      communicationStore,
      quietMinutes: 10,
      now: () => new Date("2026-09-27T10:00:00.000Z"),
    });

    expect(fetchRecord).toHaveBeenCalledWith(
      AIRTABLE_TABLE_IDS.inspections, inspectionId, expect.any(Array),
    );
    expect(upsertCaseWithoutEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        caseType: CaseType.INSPECTION,
        airtableRecordId: inspectionId,
        deviceAirtableIds: [deviceId],
      }),
      expect.any(Date),
    );
    expect(deviceUpsert).toHaveBeenCalledOnce();
    const scopeIndex = synchronizeInspectionScopes.mock.calls[0]![0];
    expect(scopeIndex.get(inspectionId)).toEqual(new Set(["recHospitalA"]));
    expect(observe).not.toHaveBeenCalled();
    expect(requestStore.status).toBe(PortalRefreshStatus.SUCCEEDED);
  });

  it.each([
    {
      scenario: "stores the canonical scheduled date when the database value is null",
      initialValue: null,
      airtableValue: "2026-09-30",
      expectedValue: "2026-09-30T00:00:00.000Z",
    },
    {
      scenario: "keeps the canonical scheduled date when it is unchanged",
      initialValue: "2026-09-30T00:00:00.000Z",
      airtableValue: "2026-09-30",
      expectedValue: "2026-09-30T00:00:00.000Z",
    },
    {
      scenario: "clears the scheduled date when the canonical Airtable field is empty",
      initialValue: "2026-09-30T00:00:00.000Z",
      airtableValue: "",
      expectedValue: null,
    },
  ])("$scenario during a normal portal refresh", async ({
    initialValue,
    airtableValue,
    expectedValue,
  }) => {
    const inspectionId = "rec2QXkBuCSLO6oeB";
    const requestStore = new MemoryWorkerStore({
      id: "refresh-inspection-dates",
      leaseToken: "assigned-by-claim",
      sourceHospitalRecordId: "recHospitalA",
      serviceOrderRecordIds: [],
      inspectionRecordIds: [inspectionId],
      deviceRecordIds: [],
      taskRecordIds: [],
    });
    let storedScheduledDate = initialValue === null ? null : new Date(initialValue);
    let storedSnapshot: Record<string, unknown> | null = null;
    const trackedCaseUpsert = vi.fn(async (args: {
      update: {
        inspectionScheduledDate: Date | null;
        sourceSnapshot: Record<string, unknown>;
      };
    }) => {
      storedScheduledDate = args.update.inspectionScheduledDate;
      storedSnapshot = args.update.sourceSnapshot;
      return { id: "tracked-inspection" };
    });
    const transaction = {
      trackedCase: { upsert: trackedCaseUpsert },
      trackedCaseDevice: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const prisma = {
      trackedCase: {
        findUnique: vi.fn().mockResolvedValue({
          id: "tracked-inspection",
          currentStatus: "W TRAKCIE REALIZACJI",
        }),
      },
      caseRecipient: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      $transaction: vi.fn(async (operation: (client: typeof transaction) => Promise<unknown>) =>
        operation(transaction)),
    } as unknown as PrismaClient;
    const fetchRecord = vi.fn(async (
      tableId: string,
      recordId: string,
      fieldIds: readonly string[],
    ) => {
      if (tableId === AIRTABLE_TABLE_IDS.hospitals) {
        return hospitalRecord([inspectionId]);
      }
      if (tableId === AIRTABLE_TABLE_IDS.inspections && recordId === inspectionId) {
        expect(fieldIds).toContain("fldKj0qH9JQzPy3CK");
        return inspectionScheduledDateRecord(recordId, airtableValue);
      }
      throw new Error(`Unexpected record ${tableId}/${recordId}`);
    });

    await runPortalRefreshWorkerOnce({
      store: requestStore,
      airtable: { fetchRecord, fetchAllRecords: vi.fn(async () => []) } as AirtableIncrementalSource,
      incrementalStore: new PrismaIncrementalStore(prisma),
      hospitalStore: noOpHospitalStore(),
      deviceStore: { upsert: vi.fn() },
      taskStore: { upsertTask: vi.fn() },
      communicationStore: noOpCommunicationStore(),
      quietMinutes: 10,
      now: () => new Date("2026-09-27T10:00:00.000Z"),
    });

    expect(INSPECTION_FIELDS.scheduledDate).toBe("fldKj0qH9JQzPy3CK");
    expect(trackedCaseUpsert).toHaveBeenCalledTimes(1);
    expect(storedScheduledDate?.toISOString() ?? null).toBe(expectedValue);
    expect(storedSnapshot).toMatchObject({
      inspectionScheduledDate: expectedValue,
    });
    expect(requestStore.status).toBe(PortalRefreshStatus.SUCCEEDED);
  });

  it("does not create duplicate communication events when the same record is manually refreshed twice", async () => {
    const work = (id: string): PortalRefreshWorkItem => ({
      id,
      leaseToken: "assigned-by-claim",
      sourceHospitalRecordId: "recHospitalA",
      serviceOrderRecordIds: ["service-A"],
      inspectionRecordIds: [],
      deviceRecordIds: [],
      taskRecordIds: ["task-A"],
    });
    const communicationStore = new IdempotentCommunicationStore();
    const incrementalStore = {
      findCase: vi.fn().mockResolvedValue(null),
      upsertCaseWithoutEvent: vi.fn().mockResolvedValue("tracked-service-A"),
      syncRecipients: vi.fn().mockResolvedValue(undefined),
    } as unknown as IncrementalStore;
    const airtable = {
      fetchAllRecords: vi.fn(async () => []),
      fetchRecord: vi.fn(async (tableId: string, recordId: string) => {
        if (tableId === AIRTABLE_TABLE_IDS.hospitals) return hospitalRecord([]);
        if (tableId === AIRTABLE_TABLE_IDS.tasks) {
          return taskRecord(recordId, "recHospitalA");
        }
        if (tableId === AIRTABLE_TABLE_IDS.serviceOrders) {
          return serviceOrderRecord(recordId, "recHospitalA", null);
        }
        if (tableId === AIRTABLE_TABLE_IDS.devices) {
          return deviceRecord(recordId, "recHospitalA");
        }
        throw new Error(`Unexpected record ${tableId}/${recordId}`);
      }),
    } as AirtableIncrementalSource;
    const common = {
      airtable,
      incrementalStore,
      hospitalStore: noOpHospitalStore(),
      deviceStore: { upsert: vi.fn() },
      taskStore: { upsertTask: vi.fn().mockResolvedValue(undefined) },
      communicationStore,
      quietMinutes: 10,
      now: () => new Date("2026-09-12T10:00:00.000Z"),
    };

    await runPortalRefreshWorkerOnce({ ...common, store: new MemoryWorkerStore(work("refresh-1")) });
    await runPortalRefreshWorkerOnce({ ...common, store: new MemoryWorkerStore(work("refresh-2")) });

    expect(communicationStore.observedCount).toBe(4);
    expect(communicationStore.createdCount).toBe(0);
  });

  it("logs the safe original Airtable cause when a portal refresh fails", async () => {
    const requestStore = new MemoryWorkerStore({
      id: "refresh-failed",
      leaseToken: "assigned-by-claim",
      sourceHospitalRecordId: "recHospitalA",
      serviceOrderRecordIds: ["service-A"],
      inspectionRecordIds: [],
      deviceRecordIds: [],
      taskRecordIds: [],
    });
    const log = vi.fn();
    const error = new AirtableRequestError(
      "Airtable record request failed",
      AIRTABLE_TABLE_IDS.serviceOrders,
      "RECORD",
      422,
      {
        airtableErrorType: "UNKNOWN_FIELD_NAME",
        airtableErrorMessage: "Unknown field: EMMA: Status przeglądu",
      },
    );

    await runPortalRefreshWorkerOnce({
      store: requestStore,
      airtable: {
        fetchAllRecords: vi.fn(async () => []),
        fetchRecord: vi.fn(async (tableId: string) => {
          if (tableId === AIRTABLE_TABLE_IDS.hospitals) return hospitalRecord([]);
          throw error;
        }),
      } as AirtableIncrementalSource,
      incrementalStore: {} as IncrementalStore,
      hospitalStore: noOpHospitalStore(),
      deviceStore: { upsert: vi.fn() },
      taskStore: { upsertTask: vi.fn() },
      communicationStore: noOpCommunicationStore(),
      quietMinutes: 10,
      now: () => new Date("2026-09-12T10:00:00.000Z"),
      log,
    });

    expect(requestStore.status).toBe(PortalRefreshStatus.FAILED);
    expect(log).toHaveBeenCalledWith(
      `PORTAL_REFRESH_FAILED requestId=refresh-failed ` +
      `errorName=AirtableRequestError errorCode=AIRTABLE_HTTP_422 requestType=RECORD ` +
      `tableId=${AIRTABLE_TABLE_IDS.serviceOrders} airtableType="UNKNOWN_FIELD_NAME" ` +
      `airtableMessage="Unknown field: EMMA: Status przeglądu"`,
    );
  });

  it("logs a safe Prisma validation root cause through IncrementalSyncStageError", async () => {
    const requestStore = new MemoryWorkerStore({
      id: "refresh-prisma-failed",
      leaseToken: "assigned-by-claim",
      sourceHospitalRecordId: "recHospitalA",
      serviceOrderRecordIds: ["service-A"],
      inspectionRecordIds: [],
      deviceRecordIds: [],
      taskRecordIds: [],
    });
    const log = vi.fn();
    const prismaError = Object.assign(new Error(
      "Invalid `prisma.trackedCase.upsert()` invocation:\n" +
      "create: { sourceSnapshot: { patient: sensitive-value } }\n" +
      "Unknown argument `productionYear`.",
    ), { name: "PrismaClientValidationError" });

    await runPortalRefreshWorkerOnce({
      store: requestStore,
      airtable: {
        fetchAllRecords: vi.fn(async () => []),
        fetchRecord: vi.fn(async (tableId: string, recordId: string) => {
          if (tableId === AIRTABLE_TABLE_IDS.hospitals) return hospitalRecord([]);
          if (tableId === AIRTABLE_TABLE_IDS.serviceOrders) {
            return serviceOrderRecord(recordId, "recHospitalA");
          }
          throw new Error(`Unexpected table ${tableId}`);
        }),
      } as AirtableIncrementalSource,
      incrementalStore: {
        findCase: vi.fn().mockRejectedValue(prismaError),
      } as unknown as IncrementalStore,
      hospitalStore: noOpHospitalStore(),
      deviceStore: { upsert: vi.fn() },
      taskStore: { upsertTask: vi.fn() },
      communicationStore: noOpCommunicationStore(),
      quietMinutes: 10,
      now: () => new Date("2026-09-12T10:00:00.000Z"),
      log,
    });

    expect(requestStore.status).toBe(PortalRefreshStatus.FAILED);
    const failure = String(log.mock.calls[0]?.[0]);
    expect(failure).toContain(
      "PORTAL_REFRESH_FAILED requestId=refresh-prisma-failed " +
      "errorName=PrismaClientValidationError errorCode=PRISMA_VALIDATION stage=DB",
    );
    expect(failure).toContain("model=TrackedCase operation=upsert");
    expect(failure).toContain('reason="Unknown argument productionYear"');
    expect(failure).not.toContain("sourceSnapshot");
    expect(failure).not.toContain("sensitive-value");
  });
});

class MemoryWorkerStore implements PortalRefreshWorkerStore {
  status = PortalRefreshStatus.PENDING;
  claimCount = 0;
  succeededCount = 0;
  activeCases = new Set<string>();
  activeDevices = new Set<string>();
  activeTasks = new Set<string>();
  constructor(private readonly work: PortalRefreshWorkItem) {
    work.serviceOrderRecordIds.forEach((id) => this.activeCases.add(`SERVICE_ORDER:${id}`));
    work.inspectionRecordIds.forEach((id) => this.activeCases.add(`INSPECTION:${id}`));
    work.deviceRecordIds.forEach((id) => this.activeDevices.add(id));
    work.taskRecordIds.forEach((id) => this.activeTasks.add(id));
  }

  async claimNext(_now: Date, leaseToken: string) {
    this.claimCount += 1;
    if (this.status !== PortalRefreshStatus.PENDING) return null;
    this.status = PortalRefreshStatus.RUNNING;
    this.work.leaseToken = leaseToken;
    return this.work;
  }
  async extendLease() { return this.status === PortalRefreshStatus.RUNNING; }
  async markSucceeded() {
    this.status = PortalRefreshStatus.SUCCEEDED;
    this.succeededCount += 1;
    return true;
  }
  async markFailed() { this.status = PortalRefreshStatus.FAILED; return true; }
  async isCaseInHospital() { return true; }
  async deactivateCase(caseType: CaseType, recordId: string) {
    return this.activeCases.delete(`${caseType}:${recordId}`);
  }
  async deactivateDevice(recordId: string) { return this.activeDevices.delete(recordId); }
  async deactivateTask(recordId: string) { return this.activeTasks.delete(recordId); }
}

function serviceOrderRecord(
  id: string,
  hospitalId: string,
  completedAt: string | null = "2026-04-01",
  productionYear: unknown = [2021],
): AirtableRecord {
  return {
    id,
    createdTime: "2026-01-10T10:00:00.000Z",
    fields: {
      [SERVICE_ORDER_FIELDS.businessNumber]: id,
      [SERVICE_ORDER_FIELDS.sourceHospitalLink]: [hospitalId],
      [SERVICE_ORDER_FIELDS.deviceLink]: ["recDeviceA"],
      [SERVICE_ORDER_FIELDS.customerStatus]: "ZAKOŃCZONE",
      [SERVICE_ORDER_FIELDS.completedAt]: completedAt,
      [SERVICE_ORDER_FIELDS.repairHeroLabel]: "DIAGNOSTYKA",
      [SERVICE_ORDER_FIELDS.repairReporter]: "Klinika",
      [SERVICE_ORDER_FIELDS.repairOfferNumber]: "OF/12",
      [SERVICE_ORDER_FIELDS.repairDescription]: "Opis naprawy",
      [SERVICE_ORDER_FIELDS.productionYear]: productionYear,
      [SERVICE_ORDER_FIELDS.sourceModifiedAt]: "2026-09-12T09:59:00.000Z",
    },
  };
}

function inspectionRecord(id: string, performedAt: string | null): AirtableRecord {
  return {
    id,
    createdTime: "2026-01-10T10:00:00.000Z",
    fields: {
      [INSPECTION_FIELDS.businessNumber]: id,
      [INSPECTION_FIELDS.performedAt]: performedAt,
      [INSPECTION_FIELDS.sourceModifiedAt]: "2026-09-12T09:59:00.000Z",
    },
  };
}

function inspectionScheduledDateRecord(
  id: string,
  scheduledDate: string,
): AirtableRecord {
  return {
    id,
    createdTime: "2026-01-10T10:00:00.000Z",
    fields: {
      [INSPECTION_FIELDS.businessNumber]: "27190",
      [INSPECTION_FIELDS.emmaStatus]: "W TRAKCIE REALIZACJI",
      [INSPECTION_FIELDS.scheduledDate]: scheduledDate,
      [INSPECTION_FIELDS.sourceModifiedAt]: "2026-09-27T09:59:00.000Z",
    },
  };
}

function hospitalRecord(inspectionIds: string[], shortName = "SZA"): AirtableRecord {
  return {
    id: "recHospitalA",
    createdTime: "2026-01-10T10:00:00.000Z",
    fields: {
      [HOSPITAL_FIELDS.shortName]: shortName,
      [HOSPITAL_FIELDS.name]: "Szpital A",
      [HOSPITAL_FIELDS.inspectionLinks]: inspectionIds,
    },
  };
}

function taskRecord(id: string, hospitalId: string): AirtableRecord {
  return {
    id,
    createdTime: "2026-01-10T10:00:00.000Z",
    fields: {
      [TASK_FIELDS.sequenceNumber]: "1",
      [TASK_FIELDS.day]: "2026-09-15",
      [TASK_FIELDS.sourceHospitalLink]: [hospitalId],
      [TASK_FIELDS.emmaCustomerStatus]: "Ustalono termin wizyty",
      [TASK_FIELDS.emmaMailTemplate]: "Przegląd-informacja_o_umówionej_wizycie",
    },
  };
}

function noOpCommunicationStore(): CommunicationEventStore {
  return {
    async isBaselineCompleted() { return true; },
    async markBaselineCompleted() {},
    async observe() { return { outcome: "NO_SCENARIO", revision: 0 }; },
  };
}

function noOpHospitalStore() {
  return {
    upsert: vi.fn(async () => undefined),
    synchronizeInspectionScopes: vi.fn(async () => ({
      scanned: 0, repaired: 0, unchanged: 0, stillUnscoped: 0, ambiguous: 0,
    })),
  };
}

class IdempotentCommunicationStore implements CommunicationEventStore {
  private readonly signatures = new Set<string>();
  observedCount = 0;
  createdCount = 0;
  async isBaselineCompleted() { return true; }
  async markBaselineCompleted() {}
  async observe(
    observation: Parameters<CommunicationEventStore["observe"]>[0],
    allowEvent: boolean,
  ) {
    this.observedCount += 1;
    if (this.signatures.has(observation.signature)) {
      return { outcome: "UNCHANGED" as const, revision: 1 };
    }
    this.signatures.add(observation.signature);
    if (!allowEvent) return { outcome: "SUPPRESSED" as const, revision: 1 };
    this.createdCount += 1;
    return { outcome: "CREATED" as const, revision: 1 };
  }
}

function deviceRecord(id: string, hospitalId: string): AirtableRecord {
  return {
    id,
    createdTime: "2026-01-10T10:00:00.000Z",
    fields: {
      [DEVICE_FIELDS.name]: "USG",
      [DEVICE_FIELDS.location]: "Nowy Oddział",
      [DEVICE_FIELDS.hospitalLink]: [hospitalId],
      [DEVICE_FIELDS.emmaDeviceStatus]: "NIESPRAWNY",
      [DEVICE_FIELDS.repairEpc]: "EPC-123",
      [DEVICE_FIELDS.sourceModifiedAt]: "2026-09-12T09:59:00.000Z",
    },
  };
}
