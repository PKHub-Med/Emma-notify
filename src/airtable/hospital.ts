import { HOSPITAL_FIELDS } from "./field-ids.js";
import type { AirtableRecord } from "./types.js";
import { toOptionalString } from "./values.js";

export type MappedHospital = {
  airtableRecordId: string;
  shortName: string | null;
  name: string | null;
  address: string | null;
};

export function mapHospital(record: AirtableRecord): MappedHospital {
  return {
    airtableRecordId: record.id,
    shortName: toOptionalString(record.fields[HOSPITAL_FIELDS.shortName]),
    name: toOptionalString(record.fields[HOSPITAL_FIELDS.name]),
    address: toOptionalString(record.fields[HOSPITAL_FIELDS.address]),
  };
}
