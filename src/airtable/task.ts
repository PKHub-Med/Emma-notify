import { TASK_FIELDS } from "./field-ids.js";
import type { AirtableRecord } from "./types.js";
import { toLinkedRecordIds, toOptionalString } from "./values.js";

export type MappedTask = {
  airtableRecordId: string;
  sequenceNumber: string | null;
  day: string | null;
  activity: string | null;
  assigneeRecordIds: string[];
  completed: boolean | null;
  status: string | null;
  serviceOrderRecordIds: string[];
  inspectionRecordIds: string[];
  contactRecordIds: string[];
  selectedContactRecordIds: string[];
  selectedContactEmailLookup: string | null;
  emmaCustomerStatus: string | null;
  emmaMailTemplate: string | null;
};

/**
 * Maps the read-only Airtable task contract without affecting notification
 * routing. In particular, recipients remain linked contact record IDs; the
 * email lookup field is informational and is not treated as canonical.
 */
export function mapTask(record: AirtableRecord): MappedTask {
  return {
    airtableRecordId: record.id,
    sequenceNumber: toOptionalString(record.fields[TASK_FIELDS.sequenceNumber]),
    day: toOptionalString(record.fields[TASK_FIELDS.day]),
    activity: toOptionalString(record.fields[TASK_FIELDS.activity]),
    assigneeRecordIds: toLinkedRecordIds(record.fields[TASK_FIELDS.assigneeLinks]),
    completed: toOptionalBoolean(record.fields[TASK_FIELDS.completed]),
    status: toOptionalString(record.fields[TASK_FIELDS.status]),
    serviceOrderRecordIds: toLinkedRecordIds(
      record.fields[TASK_FIELDS.serviceOrderLinks],
    ),
    inspectionRecordIds: toLinkedRecordIds(
      record.fields[TASK_FIELDS.inspectionLinks],
    ),
    contactRecordIds: toLinkedRecordIds(record.fields[TASK_FIELDS.contactLinks]),
    selectedContactRecordIds: toLinkedRecordIds(
      record.fields[TASK_FIELDS.selectedContactLinks],
    ),
    selectedContactEmailLookup: toOptionalString(
      record.fields[TASK_FIELDS.selectedContactEmailLookup],
    ),
    emmaCustomerStatus: toOptionalString(
      record.fields[TASK_FIELDS.emmaCustomerStatus],
    ),
    emmaMailTemplate: toOptionalString(
      record.fields[TASK_FIELDS.emmaMailTemplate],
    ),
  };
}

function toOptionalBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}
