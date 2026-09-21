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
  deviceAirtableIds: string[];
  deviceName: string | null;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  inventoryNumber: string | null;
  currentStatus: string | null;
  faultDescription: string | null;
  sourceCreatedAt: Date | null;
  reportedAt: Date | null;
  completedAt: Date | null;
  sourceModifiedAt: Date | null;
  inspectionDueDate: Date | null;
  inspectionDueDateRaw: string | null;
  inspectionScheduledDate: Date | null;
  inspectionBookingStatus: string | null;
  inspectionPerformedAt: Date | null;
  inspectionResult: string | null;
  inspectionValidUntil: Date | null;
  inspectionAdminStatus: string | null;
  inspectionHeroLabel: string | null;
  inspectionHeroDescription: string | null;
  inspectionHeaderDateType: string | null;
  inspectionHeaderDate: Date | null;
  inspectionValidation: string | null;
  inspectionNotes: string | null;
  inspectionFaults: string | null;
  inspectionAdmission: string | null;
  inspectionFailureReason: string | null;
  inspectionRequiredAction: string | null;
  relatedRepairNumber: string | null;
  inspectionDeviceTagged: string | null;
  inspectionDeviceEpc: string | null;
  sourceSnapshot: Record<string, string | number | null>;
  contactRecordIds: string[];
  invalidDueDate: boolean;
};

export function mapServiceOrder(record: AirtableRecord): MappedCase {
  const reportedAtRaw = rawString(record.fields[SERVICE_ORDER_FIELDS.reportedAt]);
  const completedAt = parseAirtableDate(
    record.fields[SERVICE_ORDER_FIELDS.completedAt],
  );
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
    department: toOptionalString(record.fields[SERVICE_ORDER_FIELDS.department]),
    reportedAtRaw,
    completedAt: completedAt?.toISOString() ?? null,
  };

  const {
    department: _department,
    completedAt: _completedAt,
    reportedAtRaw: _reportedAtRaw,
    ...storedValues
  } = values;

  return {
    caseType: CaseType.SERVICE_ORDER,
    airtableRecordId: record.id,
    ...storedValues,
    sourceHospitalRecordId: toFirstLinkedRecordId(
      record.fields[SERVICE_ORDER_FIELDS.sourceHospitalLink],
    ),
    deviceAirtableIds: toLinkedRecordIds(record.fields[SERVICE_ORDER_FIELDS.deviceLink]),
    sourceCreatedAt: parseAirtableDate(record.createdTime),
    reportedAt: parseAirtableDate(record.fields[SERVICE_ORDER_FIELDS.reportedAt]),
    completedAt,
    sourceModifiedAt: parseAirtableDate(
      record.fields[SERVICE_ORDER_FIELDS.sourceModifiedAt],
    ),
    inspectionDueDate: null,
    inspectionDueDateRaw: null,
    inspectionScheduledDate: null,
    inspectionBookingStatus: null,
    inspectionPerformedAt: null,
    inspectionResult: null,
    inspectionValidUntil: null,
    inspectionAdminStatus: null,
    inspectionHeroLabel: null,
    inspectionHeroDescription: null,
    inspectionHeaderDateType: null,
    inspectionHeaderDate: null,
    inspectionValidation: null,
    inspectionNotes: null,
    inspectionFaults: null,
    inspectionAdmission: null,
    inspectionFailureReason: null,
    inspectionRequiredAction: null,
    relatedRepairNumber: null,
    inspectionDeviceTagged: null,
    inspectionDeviceEpc: null,
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
    adminStatus: toOptionalString(record.fields[INSPECTION_FIELDS.adminStatus]),
    currentStatus: toOptionalString(record.fields[INSPECTION_FIELDS.emmaStatus]),
    heroLabel: toOptionalString(record.fields[INSPECTION_FIELDS.heroLabel]),
    heroDescription: toOptionalString(record.fields[INSPECTION_FIELDS.heroDescription]),
    headerDateType: toOptionalString(record.fields[INSPECTION_FIELDS.headerDateType]),
    headerDate: parseAirtableDate(record.fields[INSPECTION_FIELDS.headerDate])?.toISOString() ?? null,
    validation: toOptionalString(record.fields[INSPECTION_FIELDS.validation]),
    notes: toOptionalString(record.fields[INSPECTION_FIELDS.notes]),
    faults: toOptionalString(record.fields[INSPECTION_FIELDS.faults]),
    admission: toOptionalString(record.fields[INSPECTION_FIELDS.admission]),
    failureReason: toOptionalString(record.fields[INSPECTION_FIELDS.failureReason]),
    requiredAction: toOptionalString(record.fields[INSPECTION_FIELDS.requiredAction]),
    relatedRepairNumber: toOptionalString(record.fields[INSPECTION_FIELDS.relatedRepairNumber]),
    deviceTagged: toOptionalString(record.fields[INSPECTION_FIELDS.deviceTagged]),
    epc: toOptionalString(record.fields[INSPECTION_FIELDS.epc]),
    productionYear: toSingleLookupString(record.fields[INSPECTION_FIELDS.productionYear]),
    commissionedAt: toSingleLookupString(record.fields[INSPECTION_FIELDS.commissionedAt]),
    warrantyUntil: toSingleLookupString(record.fields[INSPECTION_FIELDS.warrantyUntil]),
    inspectionDueDate: inspectionDueDate?.toISOString() ?? null,
    emmaValidUntil: toOptionalString(record.fields[INSPECTION_FIELDS.emmaValidUntil]),
    inspectionDueDateRaw: invalidDueDate ? dueDateRaw : null,
    inspectionBookingStatus: toOptionalString(
      record.fields[INSPECTION_FIELDS.bookingStatus],
    ),
    inspectionScheduledDate:
      parseAirtableDate(record.fields[INSPECTION_FIELDS.scheduledDate])?.toISOString() ??
      null,
    department: toOptionalString(record.fields[INSPECTION_FIELDS.department]),
    estimatedDurationSeconds: toEstimatedDurationSeconds(
      record.fields[INSPECTION_FIELDS.estimatedDuration],
    ),
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
    deviceAirtableIds: toLinkedRecordIds(record.fields[INSPECTION_FIELDS.deviceLink]),
    deviceName: values.deviceName,
    manufacturer: values.manufacturer,
    model: values.model,
    serialNumber: values.serialNumber,
    inventoryNumber: values.inventoryNumber,
    currentStatus: values.currentStatus,
    faultDescription: null,
    sourceCreatedAt: parseAirtableDate(record.createdTime),
    reportedAt: null,
    completedAt: null,
    sourceModifiedAt: parseAirtableDate(
      record.fields[INSPECTION_FIELDS.sourceModifiedAt],
    ),
    inspectionDueDate,
    inspectionDueDateRaw: invalidDueDate ? dueDateRaw : null,
    inspectionScheduledDate: parseAirtableDate(
      record.fields[INSPECTION_FIELDS.scheduledDate],
    ),
    inspectionBookingStatus: values.inspectionBookingStatus,
    inspectionPerformedAt: parseAirtableDate(
      record.fields[INSPECTION_FIELDS.performedAt],
    ),
    inspectionResult: toOptionalString(record.fields[INSPECTION_FIELDS.result]),
    inspectionValidUntil: parseAirtableDate(
      record.fields[INSPECTION_FIELDS.emmaValidUntil],
    ),
    inspectionAdminStatus: values.adminStatus,
    inspectionHeroLabel: values.heroLabel,
    inspectionHeroDescription: values.heroDescription,
    inspectionHeaderDateType: values.headerDateType,
    inspectionHeaderDate: parseAirtableDate(record.fields[INSPECTION_FIELDS.headerDate]),
    inspectionValidation: values.validation,
    inspectionNotes: values.notes,
    inspectionFaults: values.faults,
    inspectionAdmission: values.admission,
    inspectionFailureReason: values.failureReason,
    inspectionRequiredAction: values.requiredAction,
    relatedRepairNumber: values.relatedRepairNumber,
    inspectionDeviceTagged: values.deviceTagged,
    inspectionDeviceEpc: values.epc,
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

export function toEstimatedDurationSeconds(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Number(value.trim().replace(",", "."));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function toSingleLookupString(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const normalized = toSingleLookupString(item);
      if (normalized !== null) return normalized;
    }
    return null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  return typeof value === "number" && Number.isFinite(value) ? String(value) : null;
}
