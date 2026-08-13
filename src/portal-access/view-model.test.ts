import { describe, expect, it } from "vitest";
import { CommunicationScenario } from "../generated/prisma/enums.js";
import { renderHospitalPortal } from "./portal-page.js";
import {
  HospitalPortalViewModelService,
  type HospitalPortalStore,
  type StoredPortalCase,
  type StoredPortalTask,
} from "./view-model.js";

describe("hospital portal view model", () => {
  it("keeps repairs, tasks, inspections and entry context inside hospital scope", async () => {
    const store = fixtureStore();
    const view = await new HospitalPortalViewModelService(store).build({
      sourceHospitalRecordId: "hospital-A",
      entryContext: {
        type: "TASK",
        sourceRecordId: "task-B",
        scenario: CommunicationScenario.INSPECTION_DATE_CONFIRMED,
        linkedInspectionRecordIds: ["inspection-B"],
      },
    });

    expect(view.hospital.name).toBe("Szpital A");
    expect(view.repairs.map((item) => item.sourceRecordId)).toEqual(["repair-A"]);
    expect(view.inspections.map((item) => item.sourceRecordId)).toEqual(["inspection-A"]);
    expect(JSON.stringify(view)).not.toContain("hospital-B-secret");
    expect(JSON.stringify(view)).not.toContain("inspection-B");
    expect(view.focusedCaseId).toBeNull();
    expect(store.calls).toEqual([
      ["hospital", "hospital-A"],
      ["repairs", "hospital-A"],
      ["tasks", "hospital-A"],
      ["inspections", ["inspection-A"]],
    ]);
  });

  it("focuses a scoped entry target and keeps equal device names separate by record ID", async () => {
    const store = fixtureStore({
      extraRepair: portalCase("repair-A-2", {
        deviceAirtableId: "device-A-2",
        deviceName: "Łóżko · Żółty",
      }),
    });
    const view = await new HospitalPortalViewModelService(store).build({
      sourceHospitalRecordId: "hospital-A",
      entryContext: {
        type: "SERVICE_ORDER",
        sourceRecordId: "repair-A",
        scenario: CommunicationScenario.REPAIR_COMPLETED,
      },
    });
    expect(view.focusedCaseId).toBe("repair-A");
    expect(view.devices).toHaveLength(2);
    expect(new Set(view.devices.map((device) => device.sourceRecordId)).size).toBe(2);
  });

  it("uses only the explicit customer-action allowlist", async () => {
    const view = await new HospitalPortalViewModelService(fixtureStore()).build({
      sourceHospitalRecordId: "hospital-A",
      entryContext: {
        type: "SERVICE_ORDER",
        sourceRecordId: "missing",
        scenario: CommunicationScenario.REPAIR_RECEIVED,
      },
    });
    expect(view.summary).toEqual({ requiresAction: 2, repairs: 1, inspections: 1 });
  });

  it("renders the accepted sections, exactly three summary cards and safe UTF-8", async () => {
    const store = fixtureStore({
      repair: portalCase("repair-A", {
        deviceName: "Łóżko · Żółty <svg onload=alert(1)>",
        faultDescription: "<script>alert(1)</script> Michał",
      }),
    });
    const view = await new HospitalPortalViewModelService(store).build({
      sourceHospitalRecordId: "hospital-A",
      entryContext: {
        type: "SERVICE_ORDER",
        sourceRecordId: "repair-A",
        scenario: CommunicationScenario.REPAIR_RECEIVED,
      },
    });
    const html = renderHospitalPortal(view, "safe-nonce");

    for (const id of ["summary", "devices", "repairs", "inspections", "documents"]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html.match(/class="summary-card"/g)).toHaveLength(3);
    expect(html).toContain("Łóżko · Żółty &lt;svg onload=alert(1)&gt;");
    expect(html).toContain("Michał");
    expect(html).toContain("Przegląd urządzenia");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("Ã");
    expect(html).not.toContain("Â·");
  });

  it("renders customer-friendly empty states", async () => {
    const store = fixtureStore({ empty: true });
    const view = await new HospitalPortalViewModelService(store).build({
      sourceHospitalRecordId: "hospital-A",
      entryContext: {
        type: "SERVICE_ORDER",
        sourceRecordId: "missing",
        scenario: CommunicationScenario.REPAIR_RECEIVED,
      },
    });
    const html = renderHospitalPortal(view, "safe-nonce");
    expect(html).toContain("Brak spraw dostępnych w tym widoku.");
    expect(html).toContain("Brak urządzeń pasujących do wyszukiwania.");
    expect(html).toContain("Brak dokumentów w tym widoku.");
  });
});

function fixtureStore(options: {
  empty?: boolean;
  repair?: StoredPortalCase;
  extraRepair?: StoredPortalCase;
} = {}): HospitalPortalStore & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  const repairA = options.repair ?? portalCase("repair-A");
  const repairB = portalCase("repair-B", { deviceName: "hospital-B-secret" });
  const inspectionA = portalCase("inspection-A", {
    currentStatus: "SPRAWNY",
    deviceAirtableId: "device-A",
  });
  const inspectionB = portalCase("inspection-B", { deviceName: "hospital-B-secret" });
  const tasks: Array<StoredPortalTask & { hospital: string }> = [
    {
      hospital: "hospital-A", airtableRecordId: "task-A",
      emmaCustomerStatus: "DO REALIZACJI",
      linkedInspectionRecordIds: ["inspection-A"],
      linkedServiceOrderRecordIds: [], updatedAt: new Date("2026-08-12T10:00:00Z"),
    },
    {
      hospital: "hospital-B", airtableRecordId: "task-B",
      emmaCustomerStatus: "DO REALIZACJI",
      linkedInspectionRecordIds: ["inspection-B"],
      linkedServiceOrderRecordIds: [], updatedAt: new Date("2026-08-12T10:00:00Z"),
    },
  ];
  const repairs = [
    { hospital: "hospital-A", value: repairA },
    ...(options.extraRepair ? [{ hospital: "hospital-A", value: options.extraRepair }] : []),
    { hospital: "hospital-B", value: repairB },
  ];
  const inspections = new Map([
    [inspectionA.airtableRecordId, inspectionA],
    [inspectionB.airtableRecordId, inspectionB],
  ]);
  return {
    calls,
    async findHospital(id) {
      calls.push(["hospital", id]);
      return { shortName: "SZA", name: "Szpital A", address: "Warszawa" };
    },
    async findRepairs(id) {
      calls.push(["repairs", id]);
      return options.empty ? [] : repairs.filter((item) => item.hospital === id).map((item) => item.value);
    },
    async findTasks(id) {
      calls.push(["tasks", id]);
      return options.empty ? [] : tasks.filter((item) => item.hospital === id);
    },
    async findInspections(ids) {
      calls.push(["inspections", [...ids]]);
      return ids.flatMap((id) => inspections.get(id) ?? []);
    },
  };
}

function portalCase(
  airtableRecordId: string,
  overrides: Partial<StoredPortalCase> = {},
): StoredPortalCase {
  return {
    airtableRecordId,
    businessNumber: "22466",
    clientOrderNumber: "ZL/22466",
    emmaCustomerStatus: "Oczekujemy na decyzję",
    hospitalName: "Szpital A",
    deviceAirtableId: "device-A",
    deviceName: "Łóżko · Żółty",
    manufacturer: "Michał Med",
    model: "M1",
    serialNumber: "SN-1",
    inventoryNumber: "INV-1",
    currentStatus: "Diagnostyka",
    faultDescription: "Opis",
    sourceCreatedAt: new Date("2026-08-10T10:00:00Z"),
    sourceModifiedAt: new Date("2026-08-11T10:00:00Z"),
    inspectionDueDate: new Date("2027-08-11T10:00:00Z"),
    events: [],
    ...overrides,
  };
}
