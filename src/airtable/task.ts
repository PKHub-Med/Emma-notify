import { TASK_FIELDS } from "./field-ids.js";
import type { AirtableRecord } from "./types.js";
import {
  toFirstLinkedRecordId,
  toLinkedRecordIds,
  toOptionalString,
} from "./values.js";

export type MappedTask = {
  airtableRecordId: string;
  taskNumber: string | null;
  day: string | null;
  department: string | null;
  durationSeconds: number | null;
  activity: string | null;
  performerRecordIds: string[];
  completed: boolean | null;
  status: string | null;
  linkedServiceOrderRecordIds: string[];
  linkedInspectionRecordIds: string[];
  selectedContactRecordIds: string[];
  sourceHospitalRecordId: string | null;
  emmaCustomerStatus: string | null;
  emmaMailTemplate: string | null;
};

/**
 * Maps the read-only Airtable task contract without affecting notification
 * routing. In particular, recipients remain linked contact record IDs; the
 * email lookup field is deliberately not read or treated as canonical.
 */
export function mapTask(record: AirtableRecord): MappedTask {
  return {
    airtableRecordId: record.id,
    taskNumber: toOptionalString(record.fields[TASK_FIELDS.sequenceNumber]),
    day: toOptionalString(record.fields[TASK_FIELDS.day]),
    department: toOptionalString(record.fields[TASK_FIELDS.department]),
    durationSeconds: toOptionalNumber(record.fields[TASK_FIELDS.duration]),
    activity: toOptionalString(record.fields[TASK_FIELDS.activity]),
    performerRecordIds: toLinkedRecordIds(record.fields[TASK_FIELDS.assigneeLinks]),
    completed: toOptionalBoolean(record.fields[TASK_FIELDS.completed]),
    status: toOptionalString(record.fields[TASK_FIELDS.status]),
    linkedServiceOrderRecordIds: toLinkedRecordIds(
      record.fields[TASK_FIELDS.serviceOrderLinks],
    ),
    linkedInspectionRecordIds: toLinkedRecordIds(
      record.fields[TASK_FIELDS.inspectionLinks],
    ),
    selectedContactRecordIds: toLinkedRecordIds(
      record.fields[TASK_FIELDS.selectedContactLinks],
    ),
    sourceHospitalRecordId: toFirstLinkedRecordId(
      record.fields[TASK_FIELDS.sourceHospitalLink],
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

function toOptionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
