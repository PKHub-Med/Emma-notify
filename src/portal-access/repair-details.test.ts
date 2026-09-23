import { describe, expect, it } from "vitest";
import {
  mapCase,
  repairDeviceStatus,
  type PortalCaseDevice,
  type StoredPortalCase,
} from "./view-model.js";

describe("RepairDetails", () => {
  it("uses the single related TrackedDevice and keeps Airtable presentation fields", () => {
    const item = mapCase(storedRepair(), "REPAIR", [device({
      deviceName: "Aparat USG",
      manufacturer: "Samsung",
      model: "HS40",
      department: "Kardiologia",
      emmaDeviceStatus: "NIESPRAWNY",
      productionYear: "2021",
      commissionedAt: new Date("2021-05-20T00:00:00.000Z"),
      warrantyUntil: new Date("2027-05-20T00:00:00.000Z"),
      repairEpc: "EPC-123",
    })]);

    expect(item.repairDetails).toMatchObject({
      number: "17842",
      heroLabel: "DIAGNOSTYKA",
      heroDescription: "Urządzenie jest w diagnostyce.",
      reportedAtDateOnly: true,
      reporter: "Klinika Kardiologii",
      offerNumber: "OF/2026/12",
      validation: "OK",
      device: {
        id: "recDevice",
        name: "Aparat USG",
        status: "NIESPRAWNY",
        productionYear: "2021",
        epc: "EPC-123",
        tagged: true,
      },
      location: { hospital: "Szpital", department: "Oddział ze zlecenia" },
    });
  });

  it("falls back safely when the relation is absent and optional values are empty", () => {
    const stored = storedRepair({
      repairHeroLabel: null,
      repairHeroDescription: null,
      repairReporter: null,
      repairValidation: null,
      repairOfferNumber: null,
      repairDescription: null,
      sourceSnapshot: { department: "SOR", reportedAtRaw: "2026-09-23T10:30:00.000Z" },
    });
    const item = mapCase(stored, "REPAIR", []);

    expect(item.deviceId).toBeNull();
    expect(item.repairDetails?.reportedAtDateOnly).toBe(false);
    expect(item.repairDetails?.device).toMatchObject({
      name: "Urządzenie ze zlecenia",
      status: null,
      epc: null,
      tagged: false,
    });
    expect(item.repairDetails?.location.department).toBe("SOR");
  });

  it.each([
    ["SPRAWNY", "SPRAWNY"],
    [" niesprawny ", "NIESPRAWNY"],
    ["WARUNKOWO DOPUSZCZONY", "WARUNKOWO DOPUSZCZONY"],
    ["WYCOFANY Z UŻYTKU", "WYCOFANY Z UŻYTKU"],
    ["SKASOWANY", "SKASOWANY"],
    [null, null],
    ["", null],
    ["brak formuly", null],
    ["brak formuły", null],
    ["INNY STATUS", null],
  ])("allowlists repair device status %j", (input, expected) => {
    expect(repairDeviceStatus(input)).toBe(expected);
  });

  it("prefers the service-order department over the linked Device department", () => {
    const item = mapCase(storedRepair({
      sourceSnapshot: { department: "Oddział zlecenia", reportedAtRaw: "2026-09-23" },
    }), "REPAIR", [device({ department: "Oddział urządzenia" })]);

    expect(item.repairDetails?.location.department).toBe("Oddział zlecenia");
  });
});

function device(overrides: Partial<PortalCaseDevice> = {}): PortalCaseDevice {
  return {
    sourceRecordId: "recDevice",
    deviceName: "Urządzenie",
    manufacturer: null,
    model: null,
    serialNumber: null,
    inventoryNumber: null,
    currentDeviceAccessible: true,
    ...overrides,
  };
}

function storedRepair(overrides: Partial<StoredPortalCase> = {}): StoredPortalCase {
  return {
    id: "trackedRepair",
    airtableRecordId: "recRepair",
    businessNumber: "17842",
    clientOrderNumber: "ZL/2026/12",
    emmaCustomerStatus: "Diagnostyka",
    hospitalName: "Szpital",
    deviceName: "Urządzenie ze zlecenia",
    manufacturer: "Producent ze zlecenia",
    model: "Model ze zlecenia",
    serialNumber: "SN-1",
    inventoryNumber: "INV-1",
    currentStatus: "Legacy status",
    faultDescription: "Usterka",
    completedAt: null,
    repairHeroLabel: "DIAGNOSTYKA",
    repairHeroDescription: "Urządzenie jest w diagnostyce.",
    repairReporter: "Klinika Kardiologii",
    repairValidation: "OK",
    repairOfferNumber: "OF/2026/12",
    repairDescription: "Opis naprawy",
    sourceCreatedAt: new Date("2026-09-23T00:00:00.000Z"),
    reportedAt: new Date("2026-09-23T00:00:00.000Z"),
    sourceModifiedAt: new Date("2026-09-23T10:30:00.000Z"),
    inspectionDueDate: null,
    inspectionPerformedAt: null,
    inspectionResult: null,
    inspectionValidUntil: null,
    sourceSnapshot: { department: "Oddział ze zlecenia", reportedAtRaw: "2026-09-23" },
    events: [],
    ...overrides,
  };
}
