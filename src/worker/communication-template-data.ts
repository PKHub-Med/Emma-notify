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
import {
  INSPECTION_ROW_SLOT_COUNT,
  REPAIR_ROW_SLOT_COUNT,
  TEMPLATE_STRING_VALUE_MAX_LENGTH,
  templateAliasForScenario,
  templateRowSlotKey,
} from "./communication-template-registry.js";

export type TemplateDelivery = {
  id: string;
  scenario: CommunicationScenario;
  sourceRecordId: string;
  eventSnapshot: unknown;
};

export type TemplateEmployee = {
  name: string | null;
  phone: string | null;
  email: string | null;
};

export type TemplateInspection = {
  airtableRecordId: string;
  businessNumber: string | null;
  clientOrderNumber: string | null;
  currentStatus: string | null;
  deviceName: string | null;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  inventoryNumber: string | null;
  estimatedDurationSeconds: number | null;
};

export type TemplateDevice = {
  airtableRecordId: string;
  deviceStatus: string | null;
};

export interface CommunicationTemplateDataSource {
  getEmployees(recordIds: readonly string[]): Promise<TemplateEmployee[]>;
  getInspections(recordIds: readonly string[]): Promise<TemplateInspection[]>;
  getDevices(recordIds: readonly string[]): Promise<TemplateDevice[]>;
}

export class PrismaCommunicationTemplateDataSource implements CommunicationTemplateDataSource {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly airtable: AirtableIncrementalSource,
  ) {}

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
        email: toOptionalString(record.fields[EMPLOYEE_FIELDS.email]),
      });
    }
    return employees;
  }

  async getInspections(recordIds: readonly string[]): Promise<TemplateInspection[]> {
    const records = await this.prisma.trackedCase.findMany({
      where: {
        caseType: CaseType.INSPECTION,
        airtableRecordId: { in: [...recordIds] },
      },
      select: {
        airtableRecordId: true,
        businessNumber: true,
        clientOrderNumber: true,
        currentStatus: true,
        deviceName: true,
        manufacturer: true,
        model: true,
        serialNumber: true,
        inventoryNumber: true,
        sourceSnapshot: true,
      },
    });
    const order = new Map(recordIds.map((id, index) => [id, index]));
    return records
      .map((record) => ({
        airtableRecordId: record.airtableRecordId,
        businessNumber: record.businessNumber,
        clientOrderNumber: record.clientOrderNumber,
        currentStatus: record.currentStatus,
        deviceName: record.deviceName,
        manufacturer: record.manufacturer,
        model: record.model,
        serialNumber: record.serialNumber,
        inventoryNumber: record.inventoryNumber,
        estimatedDurationSeconds: finiteSnapshotNumber(
          record.sourceSnapshot,
          "estimatedDurationSeconds",
        ),
      }))
      .sort((a, b) =>
        (order.get(a.airtableRecordId) ?? 0) - (order.get(b.airtableRecordId) ?? 0));
  }

  async getDevices(recordIds: readonly string[]): Promise<TemplateDevice[]> {
    if (recordIds.length === 0) return [];
    const records = await this.prisma.trackedDevice.findMany({
      where: { airtableRecordId: { in: [...recordIds] } },
      select: { airtableRecordId: true, deviceStatus: true },
    });
    const byId = new Map(records.map((record) => [record.airtableRecordId, record]));
    return recordIds.flatMap((id) => {
      const record = byId.get(id);
      return record ? [{
        airtableRecordId: record.airtableRecordId,
        deviceStatus: record.deviceStatus,
      }] : [];
    });
  }
}

export type CommunicationTemplatePayload = {
  templateId: string;
  variables: Record<string, TemplateVariableValue>;
};

export type CommunicationOfficeContact = {
  name: string;
  phone: string;
  email: string;
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
  officeContact?: CommunicationOfficeContact;
}): Promise<CommunicationTemplatePayload> {
  if (isRepairScenario(input.delivery.scenario)) {
    return buildCommunicationRepairBatchPayload({
      deliveries: [input.delivery],
      dataSource: input.dataSource,
      secureUrl: input.secureUrl,
      unsubscribeUrl: input.unsubscribeUrl,
      preparedAt: input.preparedAt,
      timeZone: input.timeZone,
    });
  }

  const snapshot = object(input.delivery.eventSnapshot);
  const common = commonVariables(
    input.preparedAt,
    input.timeZone,
    input.secureUrl,
    input.unsubscribeUrl,
    input.delivery.scenario,
  );
  const templateId = templateAliasForScenario(input.delivery.scenario);
  const visitDate = required(formatVisitDate(snapshot.day) ?? "");

  let inspections: TemplateInspection[];
  try {
    inspections = await input.dataSource.getInspections(
      stringArray(snapshot.linkedInspectionRecordIds),
    );
  } catch {
    throw new CommunicationTemplateDataError("TEMPLATE_DATA_SOURCE_ERROR", true);
  }

  if (input.delivery.scenario === CommunicationScenario.INSPECTION_COMPLETED) {
    const completed = inspections
      .map((inspection) => ({
        inspection,
        result: inspectionResult(inspection.currentStatus),
      }))
      .filter((item): item is {
        inspection: TemplateInspection;
        result: InspectionResult;
      } => item.result !== null)
      .sort((a, b) => a.result.order - b.result.order);

    if (completed.length === 0) {
      throw new CommunicationTemplateDataError("NO_COMPLETED_INSPECTIONS", true);
    }

    const count = (key: InspectionResult["key"]) =>
      String(completed.filter((item) => item.result.key === key).length);

    return {
      templateId,
      variables: {
        ...common,
        VISIT_DATE: visitDate,
        PASSED_COUNT: count("WORKING"),
        CONDITIONAL_COUNT: count("CONDITIONAL"),
        FAILED_COUNT: count("DEFECTIVE"),
        ...rowSlotVariables("RESULT_ROW", resultRows(completed), INSPECTION_ROW_SLOT_COUNT),
      },
    };
  }

  const base = {
    ...common,
    VISIT_DATE: visitDate,
    DEPARTMENT: display(
      snapshot.department ?? snapshot.caseLocation ?? snapshot.hospitalName,
      "—",
    ),
    DEVICE_COUNT: inspections.length,
    ...rowSlotVariables("DEVICE_ROW", deviceRows(inspections), INSPECTION_ROW_SLOT_COUNT),
  };

  if (input.delivery.scenario === CommunicationScenario.INSPECTION_DATE_CONFIRMED) {
    return { templateId, variables: base };
  }

  if (input.delivery.scenario === CommunicationScenario.INSPECTION_DATE_PROPOSED) {
    const office = input.officeContact ?? {
      name: "Tiemed",
      phone: "—",
      email: "serwis@tiemed.pl",
    };
    const subject = `Odpowiedź dotycząca terminu wizyty ${visitDate}`;
    return {
      templateId,
      variables: {
        ...base,
        COORDINATOR_NAME: required(clean(office.name)),
        COORDINATOR_PHONE: display(office.phone, "—"),
        COORDINATOR_EMAIL: required(clean(office.email)),
        COORDINATOR_REPLY_URL:
          `mailto:${encodeURIComponent(office.email)}?subject=${encodeURIComponent(subject)}`,
      },
    };
  }

  let technician: TemplateEmployee | undefined;
  const firstPerformer = stringArray(snapshot.performerRecordIds)[0];
  if (firstPerformer) {
    try {
      [technician] = await input.dataSource.getEmployees([firstPerformer]);
    } catch {
      throw new CommunicationTemplateDataError("TEMPLATE_DATA_SOURCE_ERROR", true);
    }
  }

  const phone = clean(technician?.phone) || "—";
  return {
    templateId,
    variables: {
      ...base,
      TECHNICIAN_NAME: clean(technician?.name) || "Tiemed",
      TECHNICIAN_PHONE: phone,
      TECHNICIAN_PHONE_TEL: normalizedPhone(phone) ?? "",
      TECHNICIAN_EMAIL: clean(technician?.email) || "—",
    },
  };
}

export async function buildCommunicationRepairBatchPayload(input: {
  deliveries: readonly TemplateDelivery[];
  dataSource: CommunicationTemplateDataSource;
  secureUrl: string;
  unsubscribeUrl: string;
  preparedAt: Date;
  timeZone: string;
}): Promise<CommunicationTemplatePayload> {
  if (input.deliveries.length === 0) {
    throw new CommunicationTemplateDataError("TEMPLATE_DATA_MISSING", false);
  }

  const scenario = input.deliveries[0]!.scenario;
  if (!isRepairScenario(scenario) ||
    input.deliveries.some((delivery) => delivery.scenario !== scenario)) {
    throw new CommunicationTemplateDataError(
      "TEMPLATE_BATCH_SCENARIO_MISMATCH",
      false,
    );
  }

  const snapshots = input.deliveries.map((delivery) =>
    object(delivery.eventSnapshot));
  const deviceIds = snapshots.flatMap((snapshot) => {
    const device = object(snapshot.device);
    const id = clean(device.airtableRecordId);
    return id ? [id] : [];
  });

  let devices: TemplateDevice[] = [];
  try {
    devices = await input.dataSource.getDevices([...new Set(deviceIds)]);
  } catch {
    throw new CommunicationTemplateDataError("TEMPLATE_DATA_SOURCE_ERROR", true);
  }

  const statusByDevice = new Map(
    devices.map((device) => [device.airtableRecordId, device.deviceStatus]),
  );

  const rows = snapshots.map((snapshot) => {
    const device = object(snapshot.device);
    return {
      caseNumber: required(display(snapshot.businessNumber, "")),
      clientOrderNumber: display(snapshot.clientOrderNumber, "brak numeru"),
      reportedAt: formatOptionalDate(
        snapshot.reportedAt,
        input.timeZone,
        "—",
        false,
      ),
      completedAt: formatOptionalDate(
        snapshot.completedAt,
        input.timeZone,
        formatDate(input.preparedAt, input.timeZone),
        false,
      ),
      deviceName: required(display(device.name, "")),
      manufacturer: display(device.manufacturer, "—"),
      model: display(device.model, "—"),
      serialNumber: display(device.serialNumber, "brak danych"),
      inventoryNumber: display(device.inventoryNumber, "brak danych"),
      repairStatus: display(
        snapshot.emmaCustomerStatus ?? snapshot.currentStatus,
        "Brak informacji",
      ),
      deviceStatus: display(
        statusByDevice.get(clean(device.airtableRecordId)),
        "Brak danych",
      ),
    };
  });

  const first = rows[0]!;
  const title = rows.length === 1
    ? scenario === CommunicationScenario.REPAIR_RECEIVED
      ? `Przyjęliśmy zgłoszenie serwisowe · ${first.manufacturer} · ${first.model} · ${first.serialNumber}`
      : `Naprawa zakończona · ${first.deviceName} · ${first.serialNumber} · ${first.clientOrderNumber}`
    : scenario === CommunicationScenario.REPAIR_RECEIVED
      ? `Przyjęliśmy ${rows.length} zgłoszenia serwisowe`
      : `Zakończone naprawy · ${rows.length} spraw`;

  return {
    templateId: templateAliasForScenario(scenario),
    variables: {
      ...commonVariables(
        input.preparedAt,
        input.timeZone,
        input.secureUrl,
        input.unsubscribeUrl,
        scenario,
      ),
      EMAIL_TITLE: title,
      REPAIR_COUNT: rows.length,
      ...rowSlotVariables("REPAIR_ROW", repairRows(rows, scenario), REPAIR_ROW_SLOT_COUNT),
      CASE_NUMBER: first.caseNumber,
      CLIENT_ORDER_NUMBER: first.clientOrderNumber,
      REPORTED_AT: first.reportedAt,
      COMPLETED_AT: first.completedAt,
      DEVICE_NAME: first.deviceName,
      MANUFACTURER_MODEL: joined(
        [first.manufacturer, first.model],
        "brak danych",
      ),
      SERIAL_NUMBER: first.serialNumber,
      INVENTORY_NUMBER: first.inventoryNumber,
      REPAIR_STATUS: first.repairStatus,
      DEVICE_STATUS: first.deviceStatus,
    },
  };
}

function commonVariables(
  preparedAt: Date,
  timeZone: string,
  secureUrl: string,
  unsubscribeUrl: string,
  scenario: CommunicationScenario,
) {
  return {
    SERVICE_NAME: "Tiemed",
    SENT_AT: formatDateTime(preparedAt, timeZone),
    EMMA_SECURE_URL: required(
      scenario === CommunicationScenario.INSPECTION_REMINDER
        ? `${secureUrl}#inspections`
        : secureUrl,
    ),
    EMMA_UNSUBSCRIBE_URL: required(unsubscribeUrl),
  };
}

function deviceRows(inspections: TemplateInspection[]): string[] {
  return inspections.map((inspection, index) => {
    const bottomBorder = index < inspections.length - 1
      ? "border-bottom:1px solid #D9E1EB;"
      : "";
    const details = [
      `<div style="font-size:13px;line-height:18px;font-weight:800;color:#1F2F49;">${htmlEscape(display(inspection.deviceName, "Urządzenie"))}</div>`,
      `<div style="margin-top:3px;font-size:11px;line-height:17px;color:#34445D;">Producent: ${htmlEscape(display(inspection.manufacturer, "—"))}<br>Model: ${htmlEscape(display(inspection.model, "—"))}</div>`,
      `<div style="margin-top:4px;font-size:10px;line-height:16px;color:#66758A;">SN: ${htmlEscape(display(inspection.serialNumber, "—"))} &#183; Nr inw.: ${htmlEscape(display(inspection.inventoryNumber, "—"))}<br>Numer Sprawy: ${htmlEscape(display(inspection.businessNumber, "—"))}<br>Nr zlecenia klienta: ${htmlEscape(display(inspection.clientOrderNumber, "brak numeru"))}</div>`,
    ].join("");

    return `<tr><td style="padding:13px 8px;${bottomBorder}border-right:1px solid #D9E1EB;text-align:center;vertical-align:middle;font-size:11px;line-height:17px;color:#34445D;">${index + 1}</td><td style="padding:13px 12px;${bottomBorder}border-right:1px solid #D9E1EB;vertical-align:top;">${details}</td><td style="padding:13px 8px;${bottomBorder}text-align:center;vertical-align:middle;font-size:11px;line-height:17px;font-weight:700;color:#1F2F49;white-space:nowrap;">${htmlEscape(formatDuration(inspection.estimatedDurationSeconds))}</td></tr>`;
  });
}

function repairRows(
  items: Array<{
    caseNumber: string;
    clientOrderNumber: string;
    reportedAt: string;
    completedAt: string;
    deviceName: string;
    manufacturer: string;
    model: string;
    serialNumber: string;
    inventoryNumber: string;
    repairStatus: string;
    deviceStatus: string;
  }>,
  scenario: CommunicationScenario,
): string[] {
  return items.map((item, index) => {
    const bottomBorder = index < items.length - 1
      ? "border-bottom:1px solid #D9E1EB;"
      : "";
    const date = scenario === CommunicationScenario.REPAIR_RECEIVED
      ? item.reportedAt
      : item.completedAt;

    const statuses = scenario === CommunicationScenario.REPAIR_COMPLETED
      ? `<div style="margin-top:9px;">${statusBadge(item.repairStatus, repairStatusTone(item.repairStatus))}<span style="display:inline-block;width:5px;">&nbsp;</span>${statusBadge(`Urządzenie: ${item.deviceStatus}`, deviceStatusTone(item.deviceStatus))}</div>`
      : "";

    const details = `<div style="font-size:13px;line-height:18px;font-weight:800;color:#1F2F49;">${htmlEscape(item.deviceName)}</div><div style="margin-top:3px;font-size:11px;line-height:17px;color:#34445D;">${htmlEscape(item.manufacturer)} &#183; ${htmlEscape(item.model)}</div><div style="margin-top:4px;font-size:10px;line-height:16px;color:#66758A;">SN: ${htmlEscape(item.serialNumber)} &#183; Nr inw.: ${htmlEscape(item.inventoryNumber)}<br>Numer Sprawy: ${htmlEscape(item.caseNumber)}<br>Nr zlecenia klienta: ${htmlEscape(item.clientOrderNumber)}</div>${statuses}`;

    return `<tr><td style="padding:14px 8px;${bottomBorder}border-right:1px solid #D9E1EB;text-align:center;vertical-align:middle;font-size:11px;line-height:17px;color:#34445D;">${index + 1}</td><td style="padding:14px 12px;${bottomBorder}border-right:1px solid #D9E1EB;vertical-align:top;">${details}</td><td style="padding:14px 10px;${bottomBorder}text-align:center;vertical-align:middle;font-size:11px;line-height:17px;font-weight:700;color:#1F2F49;white-space:nowrap;">${htmlEscape(date)}</td></tr>`;
  });
}

function resultRows(
  items: Array<{ inspection: TemplateInspection; result: InspectionResult }>,
): string[] {
  return items.map(({ inspection, result }, index) => {
    const bottomBorder = index < items.length - 1
      ? "border-bottom:1px solid #D9E1EB;"
      : "";
    const details = `<div style="font-size:13px;line-height:18px;font-weight:800;color:#1F2F49;">${htmlEscape(display(inspection.deviceName, "Urządzenie"))}</div><div style="margin-top:3px;font-size:11px;line-height:17px;color:#34445D;">${htmlEscape(display(inspection.manufacturer, "—"))} &#183; ${htmlEscape(display(inspection.model, "—"))}</div><div style="margin-top:4px;font-size:10px;line-height:16px;color:#66758A;">SN: ${htmlEscape(display(inspection.serialNumber, "—"))} &#183; Nr inw.: ${htmlEscape(display(inspection.inventoryNumber, "—"))}<br>Numer Sprawy: ${htmlEscape(display(inspection.businessNumber, "—"))}<br>Nr zlecenia klienta: ${htmlEscape(display(inspection.clientOrderNumber, "brak numeru"))}</div>`;
    return `<tr><td style="padding:13px 8px;${bottomBorder}border-right:1px solid #D9E1EB;text-align:center;vertical-align:middle;font-size:11px;line-height:17px;color:#34445D;">${index + 1}</td><td style="padding:13px 12px;${bottomBorder}border-right:1px solid #D9E1EB;vertical-align:top;">${details}</td><td style="padding:13px 10px;${bottomBorder}text-align:center;vertical-align:middle;">${statusBadge(result.label, inspectionResultTone(result.key))}</td></tr>`;
  });
}

function rowSlotVariables(
  prefix: string,
  rows: readonly string[],
  slotCount: number,
): Record<string, string> {
  if (rows.length > slotCount) {
    throw new CommunicationTemplateDataError("TEMPLATE_ROW_LIMIT_EXCEEDED", false);
  }

  const variables: Record<string, string> = {};
  for (let index = 0; index < slotCount; index += 1) {
    const row = rows[index] ?? "";
    if (row.length > TEMPLATE_STRING_VALUE_MAX_LENGTH) {
      throw new CommunicationTemplateDataError("TEMPLATE_VARIABLE_TOO_LARGE", false);
    }
    variables[templateRowSlotKey(prefix, index)] = row;
  }
  return variables;
}

function statusBadge(
  label: string,
  tone: { background: string; color: string; border: string },
): string {
  return `<span style="display:inline-block;padding:5px 8px;border-radius:999px;border:1px solid ${tone.border};background:${tone.background};color:${tone.color};font-size:9px;line-height:13px;font-weight:800;white-space:nowrap;">${htmlEscape(label)}</span>`;
}

function repairStatusTone(value: string) {
  const status = value.trim().toUpperCase();
  if (status.includes("ZAKOŃCZ")) {
    return { background: "#E7F3EF", color: "#2B7A64", border: "#C9E5DC" };
  }
  return { background: "#EAF0F9", color: "#33598F", border: "#D4E0F0" };
}

function deviceStatusTone(value: string) {
  const status = value.trim().toUpperCase();
  if (status.includes("NIESPRAW")) {
    return { background: "#F8E9E9", color: "#9A4949", border: "#EECFCF" };
  }
  if (status.includes("WARUNK")) {
    return { background: "#FBF1DB", color: "#8B6117", border: "#EFDCA9" };
  }
  if (status.includes("SPRAW")) {
    return { background: "#E7F3EF", color: "#2B7A64", border: "#C9E5DC" };
  }
  return { background: "#F1F4F8", color: "#66758A", border: "#D9E1EB" };
}

function inspectionResultTone(key: InspectionResult["key"]) {
  if (key === "DEFECTIVE") {
    return { background: "#F8E9E9", color: "#9A4949", border: "#EECFCF" };
  }
  if (key === "CONDITIONAL") {
    return { background: "#FBF1DB", color: "#8B6117", border: "#EFDCA9" };
  }
  return { background: "#E7F3EF", color: "#2B7A64", border: "#C9E5DC" };
}

function deviceDescription(inspection: TemplateInspection): string {
  return joined(
    [inspection.deviceName, inspection.manufacturer, inspection.model],
    "brak danych",
  );
}

export function htmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

type InspectionResult = {
  key: "DEFECTIVE" | "CONDITIONAL" | "WORKING";
  label: string;
  order: number;
};

function inspectionResult(value: string | null): InspectionResult | null {
  const status = value?.trim().toUpperCase() ?? "";
  if (status.includes("NIESPRAW")) {
    return { key: "DEFECTIVE", label: "NIESPRAWNY", order: 1 };
  }
  if (status.includes("WARUNK")) {
    return {
      key: "CONDITIONAL",
      label: "WARUNKOWO DOPUSZCZONY",
      order: 2,
    };
  }
  if (status === "SPRAWNY" || status.startsWith("SPRAWNY ")) {
    return { key: "WORKING", label: "SPRAWNY", order: 3 };
  }
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
  if (!value) {
    throw new CommunicationTemplateDataError("TEMPLATE_DATA_MISSING", false);
  }
  return value;
}

function formatVisitDate(value: unknown): string | null {
  const date = parseLocalDate(value);
  return date
    ? `${String(date.day).padStart(2, "0")}.${String(date.month).padStart(2, "0")}.${date.year}`
    : null;
}

function formatOptionalDate(
  value: unknown,
  timeZone: string,
  fallback: string,
  includeTime = true,
): string {
  if (typeof value !== "string") return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return includeTime
    ? formatDateTime(date, timeZone)
    : formatDate(date, timeZone);
}

function formatDate(value: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("pl-PL", {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(value);
}

function formatDateTime(value: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("pl-PL", {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(value);
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string =>
      typeof item === "string" && item.trim().length > 0))]
    : [];
}

function joined(values: unknown[], fallback: string): string {
  const parts = values.map(clean).filter(Boolean);
  return parts.length ? parts.join(" · ") : fallback;
}

function display(value: unknown, fallback: string): string {
  return clean(value) || fallback;
}

function clean(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/[\r\n\t]+/g, " ").trim()
    : typeof value === "number"
      ? String(value)
      : "";
}

function finiteSnapshotNumber(snapshot: unknown, key: string): number | null {
  const value = object(snapshot)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatDuration(seconds: number | null): string {
  if (seconds === null || seconds < 0) return "—";
  if (seconds < 60) return `${Math.round(seconds)} s`;

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

function isRepairScenario(scenario: CommunicationScenario): boolean {
  return scenario === CommunicationScenario.REPAIR_RECEIVED ||
    scenario === CommunicationScenario.REPAIR_COMPLETED;
}
