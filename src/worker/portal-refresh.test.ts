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
import type { IncrementalStore } from "./incremental-store.js";
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
    const fetchAllRecords = vi.fn().mockRejectedValue(new Error("must not list tables"));
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
    const listVisibleRepairs = () => portalCases.filter((item) =>
      isPortalCaseRetained("REPAIR", item.completedAt, new Date("2026-09-12T10:00:00Z")));
    expect(listVisibleRepairs()).toHaveLength(1);
    const incrementalStore = {
      findCase: vi.fn().mockResolvedValue(null),
      upsertCaseWithoutEvent: vi.fn(async (mapped: MappedCase) => {
        const item = portalCases.find((candidate) =>
          candidate.airtableRecordId === mapped.airtableRecordId);
        if (item) item.completedAt = mapped.completedAt;
        return "tracked-service-A";
      }),
      syncRecipients: vi.fn().mockResolvedValue(undefined),
    } as unknown as IncrementalStore;
    const devices: Array<{ department: string | null }> = [];
    const communicationStore = {
      isBaselineCompleted: vi.fn().mockResolvedValue(true),
      observe: vi.fn().mockResolvedValue({ outcome: "NO_SCENARIO", revision: 1 }),
      markBaselineCompleted: vi.fn(),
    } as unknown as CommunicationEventStore;
    const dependencies = {
      store: requestStore,
      airtable,
      incrementalStore,
      deviceStore: { async upsert(device: MappedDevice) {
        devices.push({ department: device.department });
      } },
      taskStore: { upsertTask: vi.fn() },
      communicationStore,
      quietMinutes: 10,
      now: () => new Date("2026-09-12T10:00:00Z"),
    };

    await expect(runPortalRefreshWorkerOnce(dependencies)).resolves.toBe(true);
    await expect(runPortalRefreshWorkerOnce(dependencies)).resolves.toBe(false);

    expect(fetchAllRecords).not.toHaveBeenCalled();
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
    expect(devices).toEqual([{ department: "Nowy Oddział" }]);
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
      airtable: { fetchRecord, fetchAllRecords: vi.fn() } as AirtableIncrementalSource,
      incrementalStore,
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
      fetchAllRecords: vi.fn(),
      fetchRecord: vi.fn(async (tableId: string, recordId: string) => {
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
      deviceStore: { upsert: vi.fn() },
      taskStore: { upsertTask: vi.fn().mockResolvedValue(undefined) },
      communicationStore,
      quietMinutes: 10,
      now: () => new Date("2026-09-12T10:00:00.000Z"),
    };

    await runPortalRefreshWorkerOnce({ ...common, store: new MemoryWorkerStore(work("refresh-1")) });
    await runPortalRefreshWorkerOnce({ ...common, store: new MemoryWorkerStore(work("refresh-2")) });

    expect(communicationStore.observedCount).toBe(4);
    expect(communicationStore.createdCount).toBe(2);
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

function hospitalRecord(inspectionIds: string[]): AirtableRecord {
  return {
    id: "recHospitalA",
    createdTime: "2026-01-10T10:00:00.000Z",
    fields: { [HOSPITAL_FIELDS.inspectionLinks]: inspectionIds },
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

class IdempotentCommunicationStore implements CommunicationEventStore {
  private readonly signatures = new Set<string>();
  observedCount = 0;
  createdCount = 0;
  async isBaselineCompleted() { return true; }
  async markBaselineCompleted() {}
  async observe(observation: Parameters<CommunicationEventStore["observe"]>[0]) {
    this.observedCount += 1;
    if (this.signatures.has(observation.signature)) {
      return { outcome: "UNCHANGED" as const, revision: 1 };
    }
    this.signatures.add(observation.signature);
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
      [DEVICE_FIELDS.sourceModifiedAt]: "2026-09-12T09:59:00.000Z",
    },
  };
}
