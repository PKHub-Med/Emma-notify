import { describe, expect, it } from "vitest";
import { CommunicationScenario, PortalAccessLevel } from "../generated/prisma/enums.js";
import type { PortalAuthorizationContext } from "./public.js";
import {
  HospitalPortalViewModelService,
  type HospitalPortalStore,
  type PortalCaseListItem,
  type PortalDataScope,
  type PortalDevice,
} from "./view-model.js";

describe("grant-context and client-history visibility", () => {
  it("shows only R1 through its SENT FALLBACK Service Order Grant A", async () => {
    const service = fixtureService(serviceGrantStore(), PortalAccessLevel.COMMUNICATION);
    expect((await service.listCases(auth("delivery-A"), { filter: "REPAIR" })).items.map(id))
      .toEqual(["R1"]);
    await expect(service.getCase(auth("delivery-A"), "R1"))
      .resolves.toMatchObject({ sourceRecordId: "R1" });
    await expect(service.getCase(auth("delivery-A"), "R2")).resolves.toBeNull();
  });

  it("does not make fallback R1 visible through later unrelated Grant B", async () => {
    const service = fixtureService(serviceGrantStore(), PortalAccessLevel.COMMUNICATION);
    expect((await service.listCases(auth("delivery-B"), { filter: "REPAIR" })).items.map(id))
      .toEqual(["R2"]);
    await expect(service.getCase(auth("delivery-B"), "R1")).resolves.toBeNull();
  });

  it("keeps SENT CLIENT R1 in communicated history through later Grant B", async () => {
    const store = serviceGrantStore();
    store.clientHistory.add("R1");
    const service = fixtureService(store, PortalAccessLevel.COMMUNICATION);
    expect((await service.listCases(auth("delivery-B"), { filter: "REPAIR" })).items.map(id))
      .toEqual(["R1", "R2"]);
    await expect(service.getCase(auth("delivery-B"), "R1"))
      .resolves.toMatchObject({ sourceRecordId: "R1" });
  });

  it("shows I1/I2 but never linked Service Order R1 through a fallback inspection TASK grant", async () => {
    const store = new GrantStore(
      [inspection("I1"), inspection("I2"), repair("R1", "D1")],
      new Map([["delivery-task", new Set(["I1", "I2"])]]),
    );
    const service = fixtureService(store, PortalAccessLevel.COMMUNICATION);
    const authorization = auth("delivery-task", "INSPECTION_TASK");
    expect((await service.listCases(authorization, { filter: "INSPECTION" })).items.map(id))
      .toEqual(["I1", "I2"]);
    expect((await service.listCases(authorization, { filter: "REPAIR", query: "R1" })).items)
      .toEqual([]);
    await expect(service.getCase(authorization, "R1")).resolves.toBeNull();
  });

  it("derives Devices and teaser counts from grant context union CLIENT history", async () => {
    const service = fixtureService(serviceGrantStore(), PortalAccessLevel.COMMUNICATION);
    const authorization = auth("delivery-A");
    expect((await service.listDevices(authorization, {})).items.map((item) => item.sourceRecordId))
      .toEqual(["D1"]);
    await expect(service.getDevice(authorization, "D1")).resolves.not.toBeNull();
    await expect(service.getDevice(authorization, "D2")).resolves.toBeNull();
    expect((await service.build(authorization)).teaser).toMatchObject({
      totalDevices: 2, visibleDevices: 1, lockedDevices: 1,
      totalRepairs: 2, visibleRepairs: 1, lockedRepairs: 1,
    });
  });

  it("keeps all Hospital cases and Devices available in FULL", async () => {
    const service = fixtureService(serviceGrantStore(), PortalAccessLevel.FULL);
    expect((await service.listCases(auth("delivery-A"), {})).items.map(id)).toEqual(["R1", "R2"]);
    expect((await service.listDevices(auth("delivery-A"), {})).items.map((item) => item.sourceRecordId))
      .toEqual(["D1", "D2"]);
  });
});

function serviceGrantStore() {
  return new GrantStore(
    [repair("R1", "D1"), repair("R2", "D2")],
    new Map([
      ["delivery-A", new Set(["R1"])],
      ["delivery-B", new Set(["R2"])],
    ]),
  );
}

function fixtureService(store: GrantStore, accessLevel: PortalAccessLevel) {
  return new HospitalPortalViewModelService(
    store, "Tiemed", 30,
    { async resolve(hospitalId) { return { hospitalId, accessLevel }; } },
  );
}

class GrantStore implements HospitalPortalStore {
  readonly clientHistory = new Set<string>();
  private readonly devices: PortalDevice[];

  constructor(
    private readonly all: PortalCaseListItem[],
    private readonly grantCases: Map<string, Set<string>>,
  ) {
    this.devices = [...new Set(all.flatMap((item) => item.deviceId ? [item.deviceId] : []))]
      .map(device);
  }

  async findHospital() { return { shortName: "H1", name: "Hospital H1", address: null }; }

  async getSummaryCounts(scope: PortalDataScope) {
    const visible = this.visible(scope);
    return {
      repairs: visible.filter((item) => item.type === "REPAIR").length,
      inspections: visible.filter((item) => item.type === "INSPECTION").length,
      devices: this.visibleDevices(scope).length, requiresAction: 0,
    };
  }

  async getTeaserCounts(scope: PortalDataScope) {
    const visible = this.visible(scope);
    const visibleRepairs = visible.filter((item) => item.type === "REPAIR").length;
    const visibleInspections = visible.filter((item) => item.type === "INSPECTION").length;
    const totalRepairs = this.all.filter((item) => item.type === "REPAIR").length;
    const totalInspections = this.all.filter((item) => item.type === "INSPECTION").length;
    const visibleDevices = this.visibleDevices(scope).length;
    return {
      totalDevices: this.devices.length, visibleDevices,
      lockedDevices: this.devices.length - visibleDevices,
      totalRepairs, visibleRepairs, lockedRepairs: totalRepairs - visibleRepairs,
      totalInspections, visibleInspections, lockedInspections: totalInspections - visibleInspections,
    };
  }

  async pageCases(scope: PortalDataScope, options: { filter: string; query: string | null; deviceId?: string }) {
    let result = this.visible(scope);
    if (options.filter === "REPAIR") result = result.filter((item) => item.type === "REPAIR");
    if (options.filter === "INSPECTION") result = result.filter((item) => item.type === "INSPECTION");
    if (options.deviceId) result = result.filter((item) => item.deviceId === options.deviceId);
    if (options.query) result = result.filter((item) => item.sourceRecordId.includes(options.query!));
    return { items: result, nextCursor: null };
  }

  async findScopedCase(scope: PortalDataScope, sourceRecordId: string) {
    return this.visible(scope).find((item) => item.sourceRecordId === sourceRecordId) ?? null;
  }

  async resolveFocusedCase(scope: PortalDataScope) { return this.visible(scope)[0] ?? null; }

  async pageDevices(scope: PortalDataScope) {
    return { items: this.visibleDevices(scope), nextCursor: null };
  }

  async findScopedDevice(scope: PortalDataScope, sourceRecordId: string) {
    const found = this.visibleDevices(scope).find((item) => item.sourceRecordId === sourceRecordId);
    if (!found) return null;
    const cases = this.visible(scope).filter((item) => item.deviceId === sourceRecordId);
    const total = this.all.filter((item) => item.deviceId === sourceRecordId).length;
    return { ...found, cases: { items: cases, nextCursor: null }, lockedCaseCount: total - cases.length };
  }

  private visible(scope: PortalDataScope) {
    if (scope.hospitalId !== "H1") return [];
    if (scope.accessLevel === PortalAccessLevel.FULL) return this.all;
    const grant = this.grantCases.get(scope.communicationDeliveryId) ?? new Set<string>();
    return this.all.filter((item) => grant.has(item.sourceRecordId) || this.clientHistory.has(item.sourceRecordId));
  }

  private visibleDevices(scope: PortalDataScope) {
    const visibleIds = new Set(this.visible(scope).flatMap((item) => item.deviceId ? [item.deviceId] : []));
    return this.devices.filter((item) => visibleIds.has(item.sourceRecordId));
  }
}

function id(item: PortalCaseListItem) { return item.sourceRecordId; }
function inspection(sourceRecordId: string) { return caseItem("INSPECTION", sourceRecordId, null); }
function repair(sourceRecordId: string, deviceId: string) { return caseItem("REPAIR", sourceRecordId, deviceId); }

function caseItem(
  type: "REPAIR" | "INSPECTION", sourceRecordId: string, deviceId: string | null,
): PortalCaseListItem {
  return {
    type, sourceRecordId, deviceId, devices: [], deviceName: deviceId ?? sourceRecordId,
    manufacturer: null, model: null, manufacturerModel: null, serialNumber: null,
    inventoryNumber: null, caseNumber: sourceRecordId, clientOrderNumber: null,
    currentStatus: "Zakończone", lastChangedAt: null, requiresAction: false,
    reportedAt: null, inspectionPerformedAt: null, validUntil: null, description: null,
    history: [], documents: [], photos: [],
  };
}

function device(sourceRecordId: string): PortalDevice {
  return {
    sourceRecordId, deviceName: sourceRecordId, manufacturer: null, model: null,
    serialNumber: null, inventoryNumber: null, currentStatus: "Aktywne",
    validUntil: null, inspectionPerformedAt: null, inspectionResult: null,
  };
}

function auth(
  communicationDeliveryId: string,
  type: "SERVICE_ORDER" | "INSPECTION_TASK" = "SERVICE_ORDER",
): PortalAuthorizationContext {
  return {
    communicationDeliveryId, sourceHospitalRecordId: "H1",
    entryContext: {
      type: type === "SERVICE_ORDER" ? "SERVICE_ORDER" : "TASK",
      sourceRecordId: type === "SERVICE_ORDER" ? "R" : "T1",
      scenario: type === "SERVICE_ORDER"
        ? CommunicationScenario.REPAIR_RECEIVED
        : CommunicationScenario.INSPECTION_COMPLETED,
    },
  };
}
