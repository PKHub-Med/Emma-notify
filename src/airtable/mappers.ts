import { CaseType } from "../generated/prisma/enums.js";
import {
  INSPECTION_FIELDS,
  SERVICE_ORDER_FIELDS,
} from "./field-ids.js";
import { parseInspectionDueDate } from "./parse-inspection-due-date.js";
import type { AirtableRecord } from "./types.js";
import {
  parseAirtableDate,
  toBusinessNumber,
  toFirstLinkedRecordId,
  toLinkedRecordIds,
  toOptionalString,
} from "./values.js";

export type MappedCase = {
  caseType: CaseType;
  airtableRecordId: string;
  businessNumber: string | null;
  clientOrderNumber: string | null;
  caseSubtype: string | null;
  serviceOrderType: string | null;
  emmaCustomerStatus: string | null;
  emmaMailTemplate: string | null;
  caseLocation: string | null;
  hospitalName: string | null;
  sourceHospitalRecordId: string | null;
  deviceAirtableId: string | null;
  deviceName: string | null;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  inventoryNumber: string | null;
  currentStatus: string | null;
  faultDescription: string | null;
  sourceCreatedAt: Date | null;
  reportedAt: Date | null;
  sourceModifiedAt: Date | null;
  inspectionDueDate: Date | null;
  inspectionDueDateRaw: string | null;
  inspectionScheduledDate: Date | null;
  inspectionBookingStatus: string | null;
  sourceSnapshot: Record<string, string | null>;
  contactRecordIds: string[];
  invalidDueDate: boolean;
};

export function mapServiceOrder(record: AirtableRecord): MappedCase {
  const values = {
    businessNumber: toBusinessNumber(record.fields[SERVICE_ORDER_FIELDS.businessNumber]),
    clientOrderNumber: toOptionalString(
      record.fields[SERVICE_ORDER_FIELDS.clientOrderNumber],
    ),
    caseSubtype: toOptionalString(record.fields[SERVICE_ORDER_FIELDS.caseSubtype]),
    serviceOrderType: toOptionalString(
      record.fields[SERVICE_ORDER_FIELDS.serviceOrderType],
    ),
    emmaCustomerStatus: toOptionalString(
      record.fields[SERVICE_ORDER_FIELDS.emmaCustomerStatus],
    ),
    emmaMailTemplate: toOptionalString(
      record.fields[SERVICE_ORDER_FIELDS.emmaMailTemplate],
    ),
    caseLocation: toOptionalString(record.fields[SERVICE_ORDER_FIELDS.caseLocation]),
    hospitalName: toOptionalString(record.fields[SERVICE_ORDER_FIELDS.hospitalName]),
    deviceName: toOptionalString(record.fields[SERVICE_ORDER_FIELDS.deviceName]),
    manufacturer: toOptionalString(record.fields[SERVICE_ORDER_FIELDS.manufacturer]),
    model: toOptionalString(record.fields[SERVICE_ORDER_FIELDS.model]),
    serialNumber: toOptionalString(record.fields[SERVICE_ORDER_FIELDS.serialNumber]),
    inventoryNumber: toOptionalString(record.fields[SERVICE_ORDER_FIELDS.inventoryNumber]),
    currentStatus: toOptionalString(record.fields[SERVICE_ORDER_FIELDS.customerStatus]),
    faultDescription: toOptionalString(
      record.fields[SERVICE_ORDER_FIELDS.faultDescription],
    ),
  };

  return {
    caseType: CaseType.SERVICE_ORDER,
    airtableRecordId: record.id,
    ...values,
    sourceHospitalRecordId: toFirstLinkedRecordId(
      record.fields[SERVICE_ORDER_FIELDS.sourceHospitalLink],
    ),
    deviceAirtableId: toFirstLinkedRecordId(
      record.fields[SERVICE_ORDER_FIELDS.deviceLink],
    ),
    sourceCreatedAt: parseAirtableDate(record.createdTime),
    reportedAt: parseAirtableDate(record.fields[SERVICE_ORDER_FIELDS.reportedAt]),
    sourceModifiedAt: parseAirtableDate(
      record.fields[SERVICE_ORDER_FIELDS.sourceModifiedAt],
    ),
    inspectionDueDate: null,
    inspectionDueDateRaw: null,
    inspectionScheduledDate: null,
    inspectionBookingStatus: null,
    sourceSnapshot: { ...values },
    contactRecordIds: toLinkedRecordIds(
      record.fields[SERVICE_ORDER_FIELDS.contactLinks],
    ),
    invalidDueDate: false,
  };
}

export function mapInspection(record: AirtableRecord): MappedCase {
  const dueDateValue = record.fields[INSPECTION_FIELDS.dueDate];
  const dueDateRaw = rawString(dueDateValue);
  const inspectionDueDate = parseInspectionDueDate(dueDateRaw);
  const invalidDueDate = Boolean(dueDateRaw && !inspectionDueDate);
  const values = {
    businessNumber: toBusinessNumber(record.fields[INSPECTION_FIELDS.businessNumber]),
    clientOrderNumber: toOptionalString(
      record.fields[INSPECTION_FIELDS.clientOrderNumber],
    ),
    hospitalName: toOptionalString(record.fields[INSPECTION_FIELDS.hospitalName]),
    deviceName: toOptionalString(record.fields[INSPECTION_FIELDS.deviceName]),
    manufacturer: toOptionalString(record.fields[INSPECTION_FIELDS.manufacturer]),
    model: toOptionalString(record.fields[INSPECTION_FIELDS.model]),
    serialNumber: toOptionalString(record.fields[INSPECTION_FIELDS.serialNumber]),
    inventoryNumber: toOptionalString(record.fields[INSPECTION_FIELDS.inventoryNumber]),
    currentStatus: toOptionalString(record.fields[INSPECTION_FIELDS.currentStatus]),
    inspectionDueDate: inspectionDueDate?.toISOString() ?? null,
    inspectionDueDateRaw: invalidDueDate ? dueDateRaw : null,
    inspectionBookingStatus: toOptionalString(
      record.fields[INSPECTION_FIELDS.bookingStatus],
    ),
    inspectionScheduledDate:
      parseAirtableDate(record.fields[INSPECTION_FIELDS.scheduledDate])?.toISOString() ??
      null,
  };

  return {
    caseType: CaseType.INSPECTION,
    airtableRecordId: record.id,
    businessNumber: values.businessNumber,
    clientOrderNumber: values.clientOrderNumber,
    caseSubtype: null,
    serviceOrderType: null,
    emmaCustomerStatus: null,
    emmaMailTemplate: null,
    caseLocation: null,
    hospitalName: values.hospitalName,
    sourceHospitalRecordId: null,
    deviceAirtableId: toFirstLinkedRecordId(record.fields[INSPECTION_FIELDS.deviceLink]),
    deviceName: values.deviceName,
    manufacturer: values.manufacturer,
    model: values.model,
    serialNumber: values.serialNumber,
    inventoryNumber: values.inventoryNumber,
    currentStatus: values.currentStatus,
    faultDescription: null,
    sourceCreatedAt: parseAirtableDate(record.createdTime),
    reportedAt: null,
    sourceModifiedAt: parseAirtableDate(
      record.fields[INSPECTION_FIELDS.sourceModifiedAt],
    ),
    inspectionDueDate,
    inspectionDueDateRaw: invalidDueDate ? dueDateRaw : null,
    inspectionScheduledDate: parseAirtableDate(
      record.fields[INSPECTION_FIELDS.scheduledDate],
    ),
    inspectionBookingStatus: values.inspectionBookingStatus,
    sourceSnapshot: { ...values },
    contactRecordIds: toLinkedRecordIds(
      record.fields[INSPECTION_FIELDS.contactLinks],
    ),
    invalidDueDate,
  };
}

function rawString(value: unknown): string | null {
  if (typeof value === "string") return value.trim() ? value : null;
  return toOptionalString(value);
}
