import { describe, expect, it } from "vitest";
import type { PrismaClient } from "../generated/prisma/client.js";
import { PortalAccessLevel } from "../generated/prisma/enums.js";
import { PrismaHospitalPortalStore, type PortalDataScope } from "./view-model.js";

const NOW = new Date("2026-10-01T10:00:00.000Z");
const DEVICE = "device-1";

describe("device-centric three-month history scope", () => {
  it.each([
    ["INSPECTION_TASK", "inspection-mail"],
    ["REPAIR", "repair-mail"],
  ] as const)("shows both inspections and repairs for a grant originating from %s", async (contextType, communicatedId) => {
    const { store } = fixture(communicatedId);
    const detail = await store.findScopedDevice(scope(contextType), DEVICE, 1);
    expect(detail?.cases.items.some((item) => item.type === "INSPECTION")).toBe(true);
    expect(detail?.cases.items.some((item) => item.type === "REPAIR")).toBe(true);
  });

  it("does not show a case older than three calendar months", async () => {
    const { store } = fixture("inspection-mail");
    const detail = await store.findScopedDevice(scope("INSPECTION_TASK"), DEVICE, 30);
    expect(detail?.cases.items.map(id)).not.toContain("repair-old");
  });

  it("returns every case in the window with newest entries first, regardless of the requested limit", async () => {
    const { store } = fixture("inspection-mail");
    const detail = await store.findScopedDevice(scope("INSPECTION_TASK"), DEVICE, 1);
    expect(detail?.cases.items.map(id)).toEqual([
      "repair-newest", "repair-history", "inspection-history", "repair-mail", "inspection-mail",
    ]);
    expect(detail?.cases.nextCursor).toBeNull();
  });

  it("does not show a recent case belonging only to another Device in the same Hospital", async () => {
    const { store } = fixture("inspection-mail");
    const detail = await store.findScopedDevice(scope("INSPECTION_TASK"), DEVICE, 30);
    expect(detail?.cases.items.map(id)).not.toContain("inspection-other-device");
  });

  it("does not show a linked case whose Hospital scope differs from the Device and grant", async () => {
    const { store } = fixture("inspection-mail");
    const detail = await store.findScopedDevice(scope("INSPECTION_TASK"), DEVICE, 30);
    expect(detail?.cases.items.map(id)).not.toContain("repair-wrong-hospital");
  });

  it("opens detail for a case revealed only by Device history", async () => {
    const { store } = fixture("inspection-mail");
    const detail = await store.findScopedCase(scope("INSPECTION_TASK"), "repair-history");
    expect(detail).toMatchObject({ sourceRecordId: "repair-history", deviceId: DEVICE });
    expect(detail?.documents).toEqual([]);
    expect(detail?.photos).toEqual([]);
  });

  it("keeps a manually guessed case outside Device history denied", async () => {
    const { store } = fixture("inspection-mail");
    await expect(store.findScopedCase(scope("INSPECTION_TASK"), "inspection-other-device"))
      .resolves.toBeNull();
    await expect(store.findScopedCase(scope("INSPECTION_TASK"), "repair-wrong-hospital"))
      .resolves.toBeNull();
    await expect(store.findScopedCase(scope("INSPECTION_TASK"), "missing"))
      .resolves.toBeNull();
  });

  it("uses business dates, exact Device relations and both Hospital predicates in SQL", async () => {
    const { store, queries } = fixture("inspection-mail");
    await store.findScopedDevice(scope("INSPECTION_TASK"), DEVICE, 30);
    const query = queries.find((item) => item.strings.join("?").includes('FROM "TrackedCaseDevice" history_link'))!;
    const sql = query.strings.join("?");
    expect(sql).toContain('c."reportedAt" IS NOT NULL');
    expect(sql).toContain('c."reportedAt" >= CAST(? AS date)');
    expect(sql).toContain('c."inspectionPerformedAt" IS NOT NULL');
    expect(sql).toContain('c."inspectionPerformedAt" >= CAST(? AS date)');
    expect(sql).toContain('history_link."trackedCaseId" = c.id');
    expect(sql).toContain('history_link."deviceAirtableId" =');
    expect(sql).toContain('d."sourceHospitalRecordId" =');
    expect(sql).toContain('c."sourceHospitalRecordId" =');
    expect(sql).toContain("communication_delivery.status = 'SENT'");
    expect(sql).toContain('communication_recipient."recipientType" = \'CLIENT\'');
    expect(query.values).toContain("2026-07-01");
    expect(query.values).toContain(DEVICE);
    expect(query.values.filter((value) => value === "hospital-1").length).toBeGreaterThan(1);
    expect(sql).not.toContain('c."sourceModifiedAt" >=');
    expect(sql).not.toContain('c."createdAt" >=');
  });
});

type TestCase = {
  id: string;
  type: "REPAIR" | "INSPECTION";
  hospitalId: string;
  deviceId: string;
  date: Date;
};

const cases: TestCase[] = [
  testCase("inspection-mail", "INSPECTION", DEVICE, "2026-08-01"),
  testCase("repair-mail", "REPAIR", DEVICE, "2026-08-02"),
  testCase("inspection-history", "INSPECTION", DEVICE, "2026-09-01"),
  testCase("repair-history", "REPAIR", DEVICE, "2026-09-02"),
  testCase("repair-newest", "REPAIR", DEVICE, "2026-09-20"),
  testCase("repair-old", "REPAIR", DEVICE, "2026-06-30"),
  testCase("inspection-other-device", "INSPECTION", "device-2", "2026-09-15"),
  { ...testCase("repair-wrong-hospital", "REPAIR", DEVICE, "2026-09-16"), hospitalId: "hospital-2" },
];

function fixture(communicatedId: string) {
  const queries: Array<{ strings: readonly string[]; values: readonly unknown[] }> = [];
  const accessibleDevices = new Set(cases
    .filter((item) => item.id === communicatedId && item.hospitalId === "hospital-1")
    .map((item) => item.deviceId));
  const prisma = {
    $queryRaw: async (query: { strings: readonly string[]; values: readonly unknown[] }) => {
      queries.push(query);
      const sql = query.strings.join("?");
      if (sql.includes('SELECT d."airtableRecordId" FROM "TrackedDevice" d')) {
        return query.values.includes(DEVICE) && accessibleDevices.has(DEVICE)
          ? [{ airtableRecordId: DEVICE }]
          : [];
      }
      if (sql.includes("SELECT DISTINCT ON")) return [];
      if (sql.includes('FROM "TrackedCaseDevice" history_link')) {
        const requestedCase = cases.find((item) => query.values.includes(item.id));
        if (sql.includes('WHERE "sourceRecordId" =') && !requestedCase) return [];
        const exactDevice = sql.includes('history_link."deviceAirtableId" =') && query.values.includes(DEVICE);
        const visible = cases.filter((item) =>
          item.hospitalId === "hospital-1" &&
          accessibleDevices.has(item.deviceId) &&
          (!exactDevice || item.deviceId === DEVICE) &&
          item.date >= new Date("2026-07-01T00:00:00.000Z") &&
          (!requestedCase || item.id === requestedCase.id));
        return visible.sort((left, right) => right.date.getTime() - left.date.getTime())
          .map((item) => ({
            type: item.type, sourceRecordId: item.id,
            sortKey: BigInt(item.date.getTime()), deviceId: item.deviceId,
          }));
      }
      if (sql.includes('WHERE "sourceRecordId" =')) {
        const communicated = cases.find((item) => item.id === communicatedId && query.values.includes(item.id));
        return communicated ? [{
          type: communicated.type, sourceRecordId: communicated.id,
          sortKey: BigInt(communicated.date.getTime()),
        }] : [];
      }
      return [];
    },
    trackedDevice: {
      findMany: async ({ where }: { where: { sourceHospitalRecordId?: string; airtableRecordId?: { in: string[] } } }) => {
        if (where.sourceHospitalRecordId !== "hospital-1") return [];
        return (where.airtableRecordId?.in ?? [...accessibleDevices])
          .filter((deviceId) => deviceId === DEVICE)
          .map(deviceRow);
      },
    },
    trackedHospital: {
      findFirst: async () => ({ shortName: "H1", name: "Hospital 1", address: null }),
    },
    trackedCase: {
      findMany: async ({ where }: { where: { OR: Array<{ airtableRecordId: string }> } }) => {
        const ids = where.OR.map((item) => item.airtableRecordId);
        return cases.filter((item) => ids.includes(item.id)).map(caseRow);
      },
    },
    trackedTask: { findMany: async () => [] },
    trackedCaseDevice: {
      findMany: async ({ where }: { where: { trackedCaseId: { in: string[] } } }) => cases
        .filter((item) => where.trackedCaseId.in.includes(`tracked-${item.id}`))
        .map((item) => ({ trackedCaseId: `tracked-${item.id}`, deviceAirtableId: item.deviceId })),
    },
    communicationDelivery: { findUnique: async () => ({ resendMessageId: "batch-1" }) },
    communicationAsset: { findMany: async () => [] },
  } as unknown as PrismaClient;
  return { store: new PrismaHospitalPortalStore(prisma, () => NOW), queries };
}

function testCase(
  id: string,
  type: TestCase["type"],
  deviceId: string,
  date: string,
): TestCase {
  return { id, type, deviceId, hospitalId: "hospital-1", date: new Date(`${date}T10:00:00.000Z`) };
}

function caseRow(item: TestCase) {
  return {
    id: `tracked-${item.id}`, airtableRecordId: item.id, businessNumber: item.id,
    clientOrderNumber: null, emmaCustomerStatus: item.type === "REPAIR" ? "Zakończona" : null,
    hospitalName: "Hospital 1", deviceName: "Device 1", manufacturer: null, model: null,
    serialNumber: null, inventoryNumber: null, currentStatus: "SPRAWNE",
    faultDescription: null, completedAt: item.type === "REPAIR" ? item.date : null,
    sourceCreatedAt: null, reportedAt: item.type === "REPAIR" ? item.date : null,
    sourceModifiedAt: null, inspectionDueDate: null,
    inspectionPerformedAt: item.type === "INSPECTION" ? item.date : null,
    inspectionResult: item.type === "INSPECTION" ? "SPRAWNE" : null,
    inspectionValidUntil: null, inspectionValidation: "OK", sourceSnapshot: {}, events: [],
  };
}

function deviceRow(airtableRecordId: string) {
  return {
    airtableRecordId, name: "Device 1", manufacturer: null, model: null,
    serialNumber: null, inventoryNumber: null, department: null, emmaDeviceStatus: "SPRAWNY",
    productionYear: null, commissionedAt: null, warrantyUntil: null, repairEpc: null,
    sourceModifiedAt: null,
  };
}

function scope(contextType: PortalDataScope["contextType"]): PortalDataScope {
  return {
    hospitalId: "hospital-1", accessLevel: PortalAccessLevel.COMMUNICATION,
    communicationDeliveryId: "delivery-1", contextType,
    contextId: contextType === "REPAIR" ? "repair-mail" : "task-1",
  };
}

function id(item: { sourceRecordId: string }) { return item.sourceRecordId; }
