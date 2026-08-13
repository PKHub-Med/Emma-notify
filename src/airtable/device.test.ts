import { describe, expect, it } from "vitest";
import { DEVICE_FIELDS } from "./field-ids.js";
import { mapDevice } from "./device.js";

describe("device mapper", () => {
  it("maps only confirmed Device fields and a unique hospital link", () => {
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
      department: null,
      location: "OIOM",
      deviceStatus: "Aktywne",
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
