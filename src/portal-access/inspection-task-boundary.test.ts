import { describe, expect, it } from "vitest";
import { PortalAccessLevel } from "../generated/prisma/enums.js";
import type { PortalAuthorizationContext } from "./public.js";
import {
  HospitalPortalViewModelService,
  type HospitalPortalStore,
  type PortalCaseListItem,
  type PortalDataScope,
} from "./view-model.js";

describe("TASK inspection communication boundary", () => {
  it("exposes I1/I2 but keeps R1 locked after SENT CLIENT INSPECTION_COMPLETED", async () => {
    const service = fixtureService("TASK_CLIENT", PortalAccessLevel.COMMUNICATION);
    expect((await service.listCases(auth(), { filter: "INSPECTION" })).items.map(id))
      .toEqual(["I1", "I2"]);
    expect((await service.listCases(auth(), { filter: "REPAIR", query: "R1" })).items)
      .toEqual([]);
    await expect(service.getCase(auth(), "R1")).resolves.toBeNull();
    expect((await service.build(auth())).teaser).toMatchObject({
      totalRepairs: 1, visibleRepairs: 0, lockedRepairs: 1,
      totalInspections: 2, visibleInspections: 2, lockedInspections: 0,
    });
  });

  it("exposes exactly R1 after its direct SENT CLIENT SERVICE_ORDER communication", async () => {
    const service = fixtureService("DIRECT_CLIENT", PortalAccessLevel.COMMUNICATION);
    expect((await service.listCases(auth(), { filter: "REPAIR" })).items.map(id)).toEqual(["R1"]);
    await expect(service.getCase(auth(), "R1")).resolves.toMatchObject({ sourceRecordId: "R1" });
  });

  it("does not expose I1, I2 or R1 for a TASK delivery to TIEMED_FALLBACK", async () => {
    const service = fixtureService("TASK_FALLBACK", PortalAccessLevel.COMMUNICATION);
    expect((await service.listCases(auth(), {})).items).toEqual([]);
    await expect(service.getCase(auth(), "I1")).resolves.toBeNull();
    await expect(service.getCase(auth(), "I2")).resolves.toBeNull();
    await expect(service.getCase(auth(), "R1")).resolves.toBeNull();
  });

  it("keeps I1/I2/R1 available in FULL within the Hospital regardless of communication", async () => {
    const service = fixtureService("TASK_FALLBACK", PortalAccessLevel.FULL);
    expect((await service.listCases(auth(), {})).items.map(id)).toEqual(["I1", "I2", "R1"]);
  });
});

type CommunicationFixture = "TASK_CLIENT" | "TASK_FALLBACK" | "DIRECT_CLIENT";

function fixtureService(fixture: CommunicationFixture, accessLevel: PortalAccessLevel) {
  return new HospitalPortalViewModelService(
    new BoundaryStore(fixture),
    "Tiemed",
    30,
    { async resolve(hospitalId) { return { hospitalId, accessLevel }; } },
  );
}

class BoundaryStore implements HospitalPortalStore {
  private readonly all = [inspection("I1"), inspection("I2"), repair("R1")];
  constructor(private readonly fixture: CommunicationFixture) {}

  async findHospital() { return { shortName: "H1", name: "Hospital H1", address: null }; }

  async getSummaryCounts(scope: PortalDataScope) {
    const visible = this.visible(scope);
    return {
      repairs: visible.filter((item) => item.type === "REPAIR").length,
      inspections: visible.filter((item) => item.type === "INSPECTION").length,
      devices: 0, requiresAction: 0,
    };
  }

  async getTeaserCounts(scope: PortalDataScope) {
    const visible = this.visible(scope);
    const visibleRepairs = visible.filter((item) => item.type === "REPAIR").length;
    const visibleInspections = visible.filter((item) => item.type === "INSPECTION").length;
    return {
      totalDevices: 0, visibleDevices: 0, lockedDevices: 0,
      totalRepairs: 1, visibleRepairs, lockedRepairs: 1 - visibleRepairs,
      totalInspections: 2, visibleInspections, lockedInspections: 2 - visibleInspections,
    };
  }

  async pageCases(scope: PortalDataScope, options: { filter: string; query: string | null }) {
    let result = this.visible(scope);
    if (options.filter === "REPAIR") result = result.filter((item) => item.type === "REPAIR");
    if (options.filter === "INSPECTION") result = result.filter((item) => item.type === "INSPECTION");
    if (options.query) result = result.filter((item) => item.sourceRecordId.includes(options.query!));
    return { items: result, nextCursor: null };
  }

  async findScopedCase(scope: PortalDataScope, sourceRecordId: string) {
    return this.visible(scope).find((item) => item.sourceRecordId === sourceRecordId) ?? null;
  }

  async resolveFocusedCase(scope: PortalDataScope) { return this.visible(scope)[0] ?? null; }
  async pageDevices() { return { items: [], nextCursor: null }; }
  async findScopedDevice() { return null; }

  private visible(scope: PortalDataScope) {
    if (scope.hospitalId !== "H1") return [];
    if (scope.accessLevel === PortalAccessLevel.FULL) return this.all;
    if (this.fixture === "TASK_CLIENT") return this.all.filter((item) => item.type === "INSPECTION");
    if (this.fixture === "DIRECT_CLIENT") return this.all.filter((item) => item.sourceRecordId === "R1");
    return [];
  }
}

function inspection(sourceRecordId: string): PortalCaseListItem { return caseItem("INSPECTION", sourceRecordId); }
function repair(sourceRecordId: string): PortalCaseListItem { return caseItem("REPAIR", sourceRecordId); }
function id(item: PortalCaseListItem) { return item.sourceRecordId; }

function caseItem(type: "REPAIR" | "INSPECTION", sourceRecordId: string): PortalCaseListItem {
  return {
    type, sourceRecordId, deviceId: null, devices: [], deviceName: sourceRecordId,
    manufacturer: null, model: null, manufacturerModel: null, serialNumber: null,
    inventoryNumber: null, caseNumber: sourceRecordId, clientOrderNumber: null,
    currentStatus: "Zakończone", lastChangedAt: null, requiresAction: false,
    reportedAt: null, inspectionPerformedAt: null, validUntil: null, description: null,
    history: [], documents: [], photos: [],
  };
}

function auth(): PortalAuthorizationContext {
  return {
    communicationDeliveryId: "delivery-task", sourceHospitalRecordId: "H1",
    entryContext: { type: "INSPECTION_TASK", sourceRecordId: "T1" },
  };
}
