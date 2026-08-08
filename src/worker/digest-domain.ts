import type { CaseType, EventType } from "../generated/prisma/enums.js";

export type DigestCaseSnapshotSource = {
  caseType: CaseType;
  airtableRecordId: string;
  businessNumber: string | null;
  clientOrderNumber: string | null;
  caseSubtype: string | null;
  caseLocation: string | null;
  hospitalName: string | null;
  deviceAirtableId: string | null;
  deviceName: string | null;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  inventoryNumber: string | null;
  currentStatus: string | null;
  faultDescription: string | null;
  inspectionDueDate: Date | null;
  inspectionScheduledDate: Date | null;
  inspectionBookingStatus: string | null;
  sourceModifiedAt: Date | null;
};

export type DigestEventSource = {
  eventType: EventType;
  fieldName: string | null;
  oldValue: unknown;
  newValue: unknown;
  detectedAt: Date;
};

export type DigestChange = {
  eventType: EventType;
  fieldName: string | null;
  oldValue: unknown;
  newValue: unknown;
  detectedAt: string;
};

export type CustomerChangeSummary = {
  type: "STATUS_CHANGED";
  from: string | null;
  to: string | null;
};

export function buildDigestSubject(itemsCount: number): string {
  return itemsCount === 1
    ? "Emma: aktualizacja dotycząca Twojego urządzenia"
    : "Emma: aktualizacje dotyczące Twoich urządzeń";
}

export function buildCaseSnapshot(trackedCase: DigestCaseSnapshotSource) {
  return {
    caseType: trackedCase.caseType,
    airtableRecordId: trackedCase.airtableRecordId,
    businessNumber: trackedCase.businessNumber,
    clientOrderNumber: trackedCase.clientOrderNumber,
    caseSubtype: trackedCase.caseSubtype,
    caseLocation: trackedCase.caseLocation,
    hospitalName: trackedCase.hospitalName,
    device: {
      airtableRecordId: trackedCase.deviceAirtableId,
      name: trackedCase.deviceName,
      manufacturer: trackedCase.manufacturer,
      model: trackedCase.model,
      serialNumber: trackedCase.serialNumber,
      inventoryNumber: trackedCase.inventoryNumber,
    },
    currentStatus: trackedCase.currentStatus,
    faultDescription: trackedCase.faultDescription,
    inspection: trackedCase.caseType === "INSPECTION"
      ? {
          dueDate: toIsoString(trackedCase.inspectionDueDate),
          scheduledDate: toIsoString(trackedCase.inspectionScheduledDate),
          bookingStatus: trackedCase.inspectionBookingStatus,
        }
      : null,
    sourceModifiedAt: toIsoString(trackedCase.sourceModifiedAt),
  };
}

export function buildDigestChanges(
  events: readonly DigestEventSource[],
): DigestChange[] {
  return events.map((event) => ({
    eventType: event.eventType,
    fieldName: event.fieldName,
    oldValue: event.oldValue,
    newValue: event.newValue,
    detectedAt: event.detectedAt.toISOString(),
  }));
}

export function buildCustomerChangeSummary(
  changes: readonly DigestChange[],
): CustomerChangeSummary | null {
  const statusChanges = changes.filter((change) => change.fieldName === "STATUS");
  const first = statusChanges[0];
  const last = statusChanges.at(-1);
  if (!first || !last) return null;

  return {
    type: "STATUS_CHANGED",
    from: toCustomerStatus(first.oldValue),
    to: toCustomerStatus(last.newValue),
  };
}

function toIsoString(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function toCustomerStatus(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
