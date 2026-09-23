import { describe, expect, it } from "vitest";
import { DEVICE_FIELDS } from "./field-ids.js";
import { mapDevice } from "./device.js";

describe("device mapper", () => {
  it("maps Airtable location to both Device location and department", () => {
    const mapped = mapDevice({
      id: "recDevice",
      createdTime: "2026-08-01T08:00:00.000Z",
      fields: {
        [DEVICE_FIELDS.name]: "USG",
        [DEVICE_FIELDS.manufacturer]: "Philips",
        [DEVICE_FIELDS.model]: "Epiq",
        [DEVICE_FIELDS.serialNumber]: "SN-1",
        [DEVICE_FIELDS.inventoryNumber]: "INV-1",
        [DEVICE_FIELDS.location]: "OIOM",
        [DEVICE_FIELDS.hospitalLink]: ["recHospital"],
        [DEVICE_FIELDS.deviceStatus]: "Aktywne",
        [DEVICE_FIELDS.emmaDeviceStatus]: "NIESPRAWNY",
        [DEVICE_FIELDS.productionYear]: 2021,
        [DEVICE_FIELDS.commissionedAt]: "2021-05-20",
        [DEVICE_FIELDS.warrantyUntil]: "2027-05-20",
        [DEVICE_FIELDS.repairEpc]: "EPC-123",
        [DEVICE_FIELDS.sourceModifiedAt]: "2026-08-14T08:00:00.000Z",
      },
    });
    expect(mapped).toMatchObject({
      airtableRecordId: "recDevice",
      sourceHospitalRecordId: "recHospital",
      name: "USG",
      manufacturer: "Philips",
      model: "Epiq",
      serialNumber: "SN-1",
      inventoryNumber: "INV-1",
      department: "OIOM",
      location: "OIOM",
      deviceStatus: "Aktywne",
      emmaDeviceStatus: "NIESPRAWNY",
      productionYear: "2021",
      repairEpc: "EPC-123",
    });
    expect(mapped.commissionedAt?.toISOString()).toBe("2021-05-20T00:00:00.000Z");
    expect(mapped.warrantyUntil?.toISOString()).toBe("2027-05-20T00:00:00.000Z");
  });

  it("keeps optional EMMA repair fields null instead of deriving them", () => {
    const mapped = mapDevice({ id: "recDevice", createdTime: "2026-08-01T08:00:00Z", fields: {} });
    expect(mapped).toMatchObject({
      emmaDeviceStatus: null,
      productionYear: null,
      commissionedAt: null,
      warrantyUntil: null,
      repairEpc: null,
    });
  });

  it("fails closed when Device has zero or multiple hospitals", () => {
    const base = { id: "recDevice", createdTime: "2026-08-01T08:00:00Z" };
    expect(mapDevice({ ...base, fields: {} }).sourceHospitalRecordId).toBeNull();
    expect(mapDevice({
      ...base,
      fields: { [DEVICE_FIELDS.hospitalLink]: ["hospital-A", "hospital-B"] },
    }).sourceHospitalRecordId).toBeNull();
  });
});
