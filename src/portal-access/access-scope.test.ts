import { describe, expect, it } from "vitest";
import { PortalAccessLevel } from "../generated/prisma/enums.js";
import type { PortalAuthorizationContext } from "./public.js";
import type { PortalAccessPolicy } from "./policy.js";
import {
  HospitalPortalViewModelService,
  type HospitalPortalStore,
  type PortalCaseListItem,
  type PortalDataScope,
  type PortalDevice,
} from "./view-model.js";

describe("portal access scope", () => {
  it("returns only 3 communicated Repairs and 2 related Devices from larger Hospital data", async () => {
    const store = new PolicyStore();
    const service = serviceAt(store, PortalAccessLevel.COMMUNICATION);
    expect((await service.listCases(auth(), { filter: "REPAIR", limit: 100 })).items).toHaveLength(3);
    expect((await service.listDevices(auth(), { limit: 100 })).items).toHaveLength(2);
    expect((await service.build(auth())).summary).toEqual({
      repairs: 3, inspections: 0, devices: 2, requiresAction: 0,
    });
  });

  it("returns teaser totals without exposing locked records through list or search", async () => {
    const service = serviceAt(new PolicyStore(), PortalAccessLevel.COMMUNICATION);
    const view = await service.build(auth());
    expect(view.teaser).toEqual({
      totalDevices: 10, visibleDevices: 2, lockedDevices: 8,
      totalRepairs: 100, visibleRepairs: 3, lockedRepairs: 97,
      totalInspections: 0, visibleInspections: 0, lockedInspections: 0,
    });
    expect((await service.listDevices(auth(), { query: "device-9" })).items).toEqual([]);
    expect((await service.listCases(auth(), { query: "repair-99" })).items).toEqual([]);
  });

  it("returns 404-shaped null for guessed locked Case and Device IDs", async () => {
    const service = serviceAt(new PolicyStore(), PortalAccessLevel.COMMUNICATION);
    await expect(service.getCase(auth("repair-0"), "repair-50")).resolves.toBeNull();
    await expect(service.getDevice(auth(), "device-9")).resolves.toBeNull();
    await expect(service.getCase(auth("repair-0"), "repair-1")).resolves.not.toBeNull();
    await expect(service.getDevice(auth(), "device-0")).resolves.not.toBeNull();
  });

  it("does not make entryContext an access scope", async () => {
    const service = serviceAt(new PolicyStore(), PortalAccessLevel.COMMUNICATION);
    await expect(service.getCase(auth("repair-0"), "repair-1")).resolves.toMatchObject({
      sourceRecordId: "repair-1",
    });
  });

  it("limits Device history in COMMUNICATION and reports the locked remainder", async () => {
    const detail = await serviceAt(new PolicyStore(), PortalAccessLevel.COMMUNICATION)
      .getDevice(auth(), "device-0", { limit: 30 });
    expect(detail?.cases.items).toHaveLength(2);
    expect(detail?.lockedCaseCount).toBe(13);
  });

  it("FULL returns all Hospital data and the full 15-item Device history", async () => {
    const service = serviceAt(new PolicyStore(), PortalAccessLevel.FULL);
    expect((await service.listCases(auth(), { filter: "REPAIR", limit: 100 })).items).toHaveLength(100);
    expect((await service.listDevices(auth(), { limit: 100 })).items).toHaveLength(10);
    const detail = await service.getDevice(auth(), "device-0", { limit: 30 });
    expect(detail?.cases.items).toHaveLength(15);
    expect(detail?.lockedCaseCount).toBe(0);
  });

  it("never returns H1 data to an H2 grant", async () => {
    const service = serviceAt(new PolicyStore(), PortalAccessLevel.FULL);
    const authorization = { ...auth(), sourceHospitalRecordId: "hospital-H2" };
    expect((await service.listCases(authorization, { limit: 100 })).items).toEqual([]);
    expect((await service.listDevices(authorization, { limit: 100 })).items).toEqual([]);
  });

  it("changes COMMUNICATION to FULL without replacing the PortalAccessGrant", async () => {
    const store = new PolicyStore();
    let level = PortalAccessLevel.COMMUNICATION;
    const policy: PortalAccessPolicy = {
      async resolve(hospitalId) { return { hospitalId, accessLevel: level }; },
    };
    const service = new HospitalPortalViewModelService(store, "Tiemed", 100, policy);
    const sameGrant = auth();
    expect((await service.listCases(sameGrant, { limit: 100 })).items).toHaveLength(3);
    level = PortalAccessLevel.FULL;
    expect((await service.listCases(sameGrant, { limit: 100 })).items).toHaveLength(100);
  });
});

function serviceAt(store: HospitalPortalStore, accessLevel: PortalAccessLevel) {
  const policy: PortalAccessPolicy = {
    async resolve(hospitalId) { return { hospitalId, accessLevel }; },
  };
  return new HospitalPortalViewModelService(store, "Tiemed", 100, policy);
}

class PolicyStore implements HospitalPortalStore {
  private readonly cases = Array.from({ length: 100 }, (_, index) => repair(index));
  private readonly devices = Array.from({ length: 10 }, (_, index) => device(index));

  async findHospital(scope: string) {
    return scope === "hospital-H1" ? { shortName: "H1", name: "Hospital H1", address: null } : null;
  }

  async getSummaryCounts(scope: PortalDataScope) {
    const cases = this.visibleCases(scope);
    return { repairs: cases.length, inspections: 0, devices: this.visibleDevices(scope).length, requiresAction: 0 };
  }

  async getTeaserCounts(scope: PortalDataScope) {
    const visibleRepairs = this.visibleCases(scope).length;
    const visibleDevices = this.visibleDevices(scope).length;
    const validHospital = scope.hospitalId === "hospital-H1";
    return {
      totalDevices: validHospital ? 10 : 0, visibleDevices,
      lockedDevices: validHospital ? 10 - visibleDevices : 0,
      totalRepairs: validHospital ? 100 : 0, visibleRepairs,
      lockedRepairs: validHospital ? 100 - visibleRepairs : 0,
      totalInspections: 0, visibleInspections: 0, lockedInspections: 0,
    };
  }

  async pageCases(scope: PortalDataScope, options: { filter: string; query: string | null; limit: number; deviceId?: string }) {
    let cases = this.visibleCases(scope);
    if (options.deviceId) cases = cases.filter((item) => item.deviceId === options.deviceId);
    if (options.query) cases = cases.filter((item) => JSON.stringify(item).toLowerCase().includes(options.query!.toLowerCase()));
    return { items: cases.slice(0, options.limit), nextCursor: null };
  }

  async findScopedCase(scope: PortalDataScope, sourceRecordId: string) {
    return this.visibleCases(scope).find((item) => item.sourceRecordId === sourceRecordId) ?? null;
  }

  async resolveFocusedCase(scope: PortalDataScope) {
    return this.findScopedCase(scope, scope.contextId);
  }

  async pageDevices(scope: PortalDataScope, options: { query: string | null; limit: number }) {
    let devices = this.visibleDevices(scope);
    if (options.query) devices = devices.filter((item) => JSON.stringify(item).toLowerCase().includes(options.query!.toLowerCase()));
    return { items: devices.slice(0, options.limit), nextCursor: null };
  }

  async findScopedDevice(scope: PortalDataScope, sourceRecordId: string, limit: number) {
    const found = this.visibleDevices(scope).find((item) => item.sourceRecordId === sourceRecordId);
    if (!found) return null;
    const total = this.cases.filter((item) => item.deviceId === sourceRecordId).length;
    const visible = this.visibleCases(scope).filter((item) => item.deviceId === sourceRecordId);
    return {
      ...found, cases: { items: visible.slice(0, limit), nextCursor: null },
      lockedCaseCount: Math.max(0, total - visible.length),
    };
  }

  private visibleCases(scope: PortalDataScope) {
    if (scope.hospitalId !== "hospital-H1") return [];
    return scope.accessLevel === PortalAccessLevel.FULL ? this.cases : this.cases.slice(0, 3);
  }

  private visibleDevices(scope: PortalDataScope) {
    if (scope.hospitalId !== "hospital-H1") return [];
    return scope.accessLevel === PortalAccessLevel.FULL ? this.devices : this.devices.slice(0, 2);
  }
}

function repair(index: number): PortalCaseListItem {
  return {
    type: "REPAIR", sourceRecordId: `repair-${index}`,
    deviceId: index === 2 ? "device-1" : index <= 15 ? "device-0" : `device-${(index % 9) + 1}`,
    devices: [], deviceName: `Device ${index}`, manufacturer: null, model: null,
    manufacturerModel: null, serialNumber: null, inventoryNumber: null,
    caseNumber: `${index}`, clientOrderNumber: null, currentStatus: "Diagnostyka",
    lastChangedAt: null, requiresAction: false, reportedAt: null,
    inspectionPerformedAt: null, validUntil: null, description: null,
    history: [], documents: [], photos: [],
  };
}

function device(index: number): PortalDevice {
  return {
    sourceRecordId: `device-${index}`, deviceName: `Device ${index}`,
    manufacturer: null, model: null, serialNumber: null, inventoryNumber: null,
    currentStatus: "Aktywne", validUntil: null, inspectionPerformedAt: null,
    inspectionResult: null,
  };
}

function auth(sourceRecordId = "repair-0"): PortalAuthorizationContext {
  return {
    communicationDeliveryId: "delivery-1", sourceHospitalRecordId: "hospital-H1",
    entryContext: { type: "SERVICE_ORDER", sourceRecordId },
  };
}
