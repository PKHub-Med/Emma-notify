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
  sourceCreatedAt: Date | null;
  sourceModifiedAt: Date | null;
};

export function mapDevice(record: AirtableRecord): MappedDevice {
  const hospitalIds = toLinkedRecordIds(record.fields[DEVICE_FIELDS.hospitalLink]);
  return {
    airtableRecordId: record.id,
    sourceHospitalRecordId: hospitalIds.length === 1 ? hospitalIds[0]! : null,
    name: toOptionalString(record.fields[DEVICE_FIELDS.name]),
    manufacturer: toOptionalString(record.fields[DEVICE_FIELDS.manufacturer]),
    model: toOptionalString(record.fields[DEVICE_FIELDS.model]),
    serialNumber: toOptionalString(record.fields[DEVICE_FIELDS.serialNumber]),
    inventoryNumber: toOptionalString(record.fields[DEVICE_FIELDS.inventoryNumber]),
    department: null,
    location: toOptionalString(record.fields[DEVICE_FIELDS.location]),
    deviceStatus: toOptionalString(record.fields[DEVICE_FIELDS.deviceStatus]),
    sourceCreatedAt: parseAirtableDate(record.createdTime),
    sourceModifiedAt: parseAirtableDate(record.fields[DEVICE_FIELDS.sourceModifiedAt]),
  };
}
