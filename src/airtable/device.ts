import { DEVICE_FIELDS } from "./field-ids.js";
import type { AirtableRecord } from "./types.js";
import { parseAirtableDate, toLinkedRecordIds, toOptionalString } from "./values.js";

export type MappedDevice = {
  airtableRecordId: string;
  sourceHospitalRecordId: string | null;
  name: string | null;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  inventoryNumber: string | null;
  department: string | null;
  location: string | null;
  deviceStatus: string | null;
  emmaDeviceStatus: string | null;
  productionYear: string | null;
  commissionedAt: Date | null;
  warrantyUntil: Date | null;
  repairEpc: string | null;
  sourceCreatedAt: Date | null;
  sourceModifiedAt: Date | null;
};

export function mapDevice(record: AirtableRecord): MappedDevice {
  const hospitalIds = toLinkedRecordIds(record.fields[DEVICE_FIELDS.hospitalLink]);
  const location = toOptionalString(record.fields[DEVICE_FIELDS.location]);
  return {
    airtableRecordId: record.id,
    sourceHospitalRecordId: hospitalIds.length === 1 ? hospitalIds[0]! : null,
    name: toOptionalString(record.fields[DEVICE_FIELDS.name]),
    manufacturer: toOptionalString(record.fields[DEVICE_FIELDS.manufacturer]),
    model: toOptionalString(record.fields[DEVICE_FIELDS.model]),
    serialNumber: toOptionalString(record.fields[DEVICE_FIELDS.serialNumber]),
    inventoryNumber: toOptionalString(record.fields[DEVICE_FIELDS.inventoryNumber]),
    department: location,
    location,
    deviceStatus: toOptionalString(record.fields[DEVICE_FIELDS.deviceStatus]),
    emmaDeviceStatus: toOptionalString(record.fields[DEVICE_FIELDS.emmaDeviceStatus]),
    productionYear: toProductionYear(record.fields[DEVICE_FIELDS.productionYear]),
    commissionedAt: parseAirtableDate(record.fields[DEVICE_FIELDS.commissionedAt]),
    warrantyUntil: parseAirtableDate(record.fields[DEVICE_FIELDS.warrantyUntil]),
    repairEpc: toOptionalString(record.fields[DEVICE_FIELDS.repairEpc]),
    sourceCreatedAt: parseAirtableDate(record.createdTime),
    sourceModifiedAt: parseAirtableDate(record.fields[DEVICE_FIELDS.sourceModifiedAt]),
  };
}

function toProductionYear(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return toOptionalString(value);
}
