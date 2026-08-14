import type { PrismaClient } from "../generated/prisma/client.js";
import { CaseType, CommunicationScenario } from "../generated/prisma/enums.js";
import {
  AIRTABLE_TABLE_IDS,
  EMPLOYEE_FIELD_IDS,
  EMPLOYEE_FIELDS,
} from "../airtable/field-ids.js";
import type { AirtableIncrementalSource } from "../airtable/types.js";
import { toOptionalString } from "../airtable/values.js";
import type { TemplateVariableValue } from "../email/resend-client.js";
import { parseLocalDate } from "./communication-time.js";
import { templateAliasForScenario } from "./communication-template-registry.js";

export type TemplateDelivery = {
  id: string;
  scenario: CommunicationScenario;
  sourceRecordId: string;
  eventSnapshot: unknown;
};

export type TemplateEmployee = { name: string | null; phone: string | null };
export type TemplateInspection = {
  airtableRecordId: string;
  currentStatus: string | null;
  deviceName: string | null;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  inventoryNumber: string | null;
};

export interface CommunicationTemplateDataSource {
  getEmployees(recordIds: readonly string[]): Promise<TemplateEmployee[]>;
  getInspections(recordIds: readonly string[]): Promise<TemplateInspection[]>;
}

export class PrismaCommunicationTemplateDataSource implements CommunicationTemplateDataSource {
  constructor(private readonly prisma: PrismaClient, private readonly airtable: AirtableIncrementalSource) {}

  async getEmployees(recordIds: readonly string[]): Promise<TemplateEmployee[]> {
    const employees: TemplateEmployee[] = [];
    for (const recordId of recordIds) {
      const record = await this.airtable.fetchRecord(
        AIRTABLE_TABLE_IDS.employees,
        recordId,
        EMPLOYEE_FIELD_IDS,
      );
      employees.push({
        name: toOptionalString(record.fields[EMPLOYEE_FIELDS.name]),
        phone: toOptionalString(record.fields[EMPLOYEE_FIELDS.businessPhone]),
      });
    }
    return employees;
  }

  async getInspections(recordIds: readonly string[]): Promise<TemplateInspection[]> {
    const records = await this.prisma.trackedCase.findMany({
      where: { caseType: CaseType.INSPECTION, airtableRecordId: { in: [...recordIds] } },
      select: {
        airtableRecordId: true, currentStatus: true, deviceName: true,
        manufacturer: true, model: true, serialNumber: true, inventoryNumber: true,
      },
    });
    const order = new Map(recordIds.map((id, index) => [id, index]));
    return records.sort((a, b) => (order.get(a.airtableRecordId) ?? 0) - (order.get(b.airtableRecordId) ?? 0));
  }
}

export type CommunicationTemplatePayload = {
  templateId: string;
  variables: Record<string, TemplateVariableValue>;
};

export class CommunicationTemplateDataError extends Error {
  constructor(readonly code: string, readonly retryable: boolean) {
    super(code);
    this.name = "CommunicationTemplateDataError";
  }
}

export async function buildCommunicationTemplatePayload(input: {
  delivery: TemplateDelivery;
  dataSource: CommunicationTemplateDataSource;
  secureUrl: string;
  unsubscribeUrl: string;
  preparedAt: Date;
  timeZone: string;
}): Promise<CommunicationTemplatePayload> {
  const snapshot = object(input.delivery.eventSnapshot);
  const common = {
    SERVICE_NAME: "Tiemed",
    SENT_AT: formatDateTime(input.preparedAt, input.timeZone),
    EMMA_SECURE_URL: required(input.secureUrl),
    EMMA_UNSUBSCRIBE_URL: required(input.unsubscribeUrl),
  };
  const templateId = templateAliasForScenario(input.delivery.scenario);

  if (input.delivery.scenario === CommunicationScenario.REPAIR_RECEIVED ||
      input.delivery.scenario === CommunicationScenario.REPAIR_COMPLETED) {
    const device = object(snapshot.device);
    const base = {
      ...common,
      CASE_NUMBER: required(display(snapshot.businessNumber, "")),
      CLIENT_ORDER_NUMBER: display(snapshot.clientOrderNumber, "brak numeru"),
      DEVICE_NAME: required(display(device.name, "")),
      MANUFACTURER_MODEL: joined([device.manufacturer, device.model], "brak danych"),
      SERIAL_NUMBER: display(device.serialNumber, "brak danych"),
      INVENTORY_NUMBER: display(device.inventoryNumber, "brak danych"),
    };
    return input.delivery.scenario === CommunicationScenario.REPAIR_RECEIVED
      ? { templateId, variables: { ...base, REPORTED_AT: formatOptionalDate(snapshot.sourceCreatedAt, input.timeZone, "—") } }
      : { templateId, variables: { ...base, COMPLETED_AT: formatOptionalDate(snapshot.detectedAt, input.timeZone, formatDateTime(input.preparedAt, input.timeZone)) } };
  }

  const visitDate = required(formatVisitDate(snapshot.day) ?? "");
  let inspections: TemplateInspection[];
  try {
    inspections = await input.dataSource.getInspections(stringArray(snapshot.linkedInspectionRecordIds));
  } catch {
    throw new CommunicationTemplateDataError("TEMPLATE_DATA_SOURCE_ERROR", true);
  }

  if (input.delivery.scenario === CommunicationScenario.INSPECTION_COMPLETED) {
    const completed = inspections
      .map((inspection) => ({ inspection, result: inspectionResult(inspection.currentStatus) }))
      .filter((item): item is { inspection: TemplateInspection; result: InspectionResult } => item.result !== null)
      .sort((a, b) => a.result.order - b.result.order);
    if (completed.length === 0) throw new CommunicationTemplateDataError("NO_COMPLETED_INSPECTIONS", true);
    const count = (key: InspectionResult["key"]) => String(completed.filter((item) => item.result.key === key).length);
    return { templateId, variables: {
      ...common,
      VISIT_DATE: visitDate,
      PASSED_COUNT: count("WORKING"),
      CONDITIONAL_COUNT: count("CONDITIONAL"),
      FAILED_COUNT: count("DEFECTIVE"),
      RESULT_ROWS: resultRows(completed),
    } };
  }

  const base = {
    ...common,
    VISIT_DATE: visitDate,
    DEPARTMENT: display(snapshot.department ?? snapshot.caseLocation ?? snapshot.hospitalName, "—"),
    DEVICE_COUNT: inspections.length,
    DEVICES_ROWS: deviceRows(inspections),
  };
  if (input.delivery.scenario === CommunicationScenario.INSPECTION_DATE_CONFIRMED) {
    return { templateId, variables: base };
  }

  let employees: TemplateEmployee[];
  try {
    employees = await input.dataSource.getEmployees(stringArray(snapshot.performerRecordIds));
  } catch {
    throw new CommunicationTemplateDataError("TEMPLATE_DATA_SOURCE_ERROR", true);
  }
  if (input.delivery.scenario === CommunicationScenario.INSPECTION_DATE_PROPOSED) {
    const coordinator = employees.find((employee) => clean(employee.name) || clean(employee.phone));
    const subject = `Odpowiedź dotycząca terminu wizyty ${visitDate}`;
    return { templateId, variables: {
      ...base,
      COORDINATOR_NAME: clean(coordinator?.name) || "Tiemed",
      COORDINATOR_PHONE: clean(coordinator?.phone) || "—",
      COORDINATOR_EMAIL: "serwis@tiemed.pl",
      COORDINATOR_REPLY_URL: `mailto:serwis@tiemed.pl?subject=${encodeURIComponent(subject)}`,
    } };
  }
  const technician = employees.find((employee) => normalizedPhone(employee.phone) !== null);
  const phone = clean(technician?.phone) || "—";
  return { templateId, variables: {
    ...base,
    TECHNICIAN_NAME: clean(technician?.name) || "Tiemed",
    TECHNICIAN_PHONE: phone,
    TECHNICIAN_PHONE_TEL: normalizedPhone(phone) ?? "",
  } };
}

function deviceRows(inspections: TemplateInspection[]): string {
  return inspections.map((inspection, index) => `<tr><td>${index + 1}</td><td>${htmlEscape(deviceDescription(inspection))}</td><td>—</td></tr>`).join("");
}

function resultRows(items: Array<{ inspection: TemplateInspection; result: InspectionResult }>): string {
  return items.map(({ inspection, result }, index) => `<tr><td>${index + 1}</td><td>${htmlEscape(deviceDescription(inspection))}</td><td>${htmlEscape(result.label)}</td></tr>`).join("");
}

function deviceDescription(inspection: TemplateInspection): string {
  return joined([inspection.deviceName, inspection.manufacturer, inspection.model], "brak danych");
}

export function htmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

type InspectionResult = { key: "DEFECTIVE" | "CONDITIONAL" | "WORKING"; label: string; order: number };
function inspectionResult(value: string | null): InspectionResult | null {
  const status = value?.trim().toUpperCase() ?? "";
  if (status.includes("NIESPRAW")) return { key: "DEFECTIVE", label: "NIESPRAWNY", order: 1 };
  if (status.includes("WARUNK")) return { key: "CONDITIONAL", label: "WARUNKOWO DOPUSZCZONY", order: 2 };
  if (status === "SPRAWNY" || status.startsWith("SPRAWNY ")) return { key: "WORKING", label: "SPRAWNY", order: 3 };
  return null;
}

function normalizedPhone(value: unknown): string | null {
  const raw = clean(value);
  if (!raw) return null;
  const hasPlus = raw.startsWith("+");
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  return `tel:${hasPlus ? "+" : ""}${digits}`;
}
function required(value: string): string {
  if (!value) throw new CommunicationTemplateDataError("TEMPLATE_DATA_MISSING", false);
  return value;
}
function formatVisitDate(value: unknown): string | null {
  const date = parseLocalDate(value);
  return date ? `${String(date.day).padStart(2, "0")}.${String(date.month).padStart(2, "0")}.${date.year}` : null;
}
function formatOptionalDate(value: unknown, timeZone: string, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : formatDateTime(date, timeZone);
}
function formatDateTime(value: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("pl-PL", { timeZone, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(value);
}
function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string" && item.trim().length > 0))] : [];
}
function joined(values: unknown[], fallback: string): string {
  const parts = values.map(clean).filter(Boolean);
  return parts.length ? parts.join(" · ") : fallback;
}
function display(value: unknown, fallback: string): string { return clean(value) || fallback; }
function clean(value: unknown): string {
  return typeof value === "string" ? value.replace(/[\r\n\t]+/g, " ").trim() : typeof value === "number" ? String(value) : "";
}
