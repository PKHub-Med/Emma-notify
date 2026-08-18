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
        RESULT_ROWS: resultRows(completed),
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
    DEVICES_ROWS: deviceRows(inspections),
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
      REPAIRS_ROWS: repairRows(rows, scenario),
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

function deviceRows(inspections: TemplateInspection[]): string {
  return inspections.map((inspection, index) => {
    const details = [
      `<strong>${htmlEscape(display(inspection.deviceName, "Urządzenie"))}</strong>`,
      `Producent: ${htmlEscape(display(inspection.manufacturer, "—"))}`,
      `Model: ${htmlEscape(display(inspection.model, "—"))}`,
      `SN: ${htmlEscape(display(inspection.serialNumber, "—"))}`,
      `Nr inw.: ${htmlEscape(display(inspection.inventoryNumber, "—"))}`,
      `Nr zlecenia klienta: ${htmlEscape(display(inspection.clientOrderNumber, "brak numeru"))}`,
      `Numer Sprawy: ${htmlEscape(display(inspection.businessNumber, "—"))}`,
    ].join("<br>");

    return `<tr><td style="text-align:center">${index + 1}</td><td>${details}</td><td style="text-align:center">${htmlEscape(formatDuration(inspection.estimatedDurationSeconds))}</td></tr>`;
  }).join("");
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
): string {
  return items.map((item, index) => {
    const dateLabel = scenario === CommunicationScenario.REPAIR_RECEIVED
      ? `Data zgłoszenia: ${item.reportedAt}`
      : `Data zakończenia: ${item.completedAt}`;

    const status = scenario === CommunicationScenario.REPAIR_COMPLETED
      ? `<br>Status naprawy: ${htmlEscape(item.repairStatus)}<br>Status urządzenia: ${htmlEscape(item.deviceStatus)}`
      : "";

    return `<tr><td style="text-align:center">${index + 1}</td><td><strong>${htmlEscape(item.deviceName)}</strong><br>${htmlEscape(item.manufacturer)} · ${htmlEscape(item.model)}<br>SN: ${htmlEscape(item.serialNumber)} · Nr inw.: ${htmlEscape(item.inventoryNumber)}<br>Numer Sprawy: ${htmlEscape(item.caseNumber)}<br>Nr zlecenia klienta: ${htmlEscape(item.clientOrderNumber)}<br>${htmlEscape(dateLabel)}${status}</td></tr>`;
  }).join("");
}

function resultRows(
  items: Array<{ inspection: TemplateInspection; result: InspectionResult }>,
): string {
  return items.map(({ inspection, result }, index) =>
    `<tr><td>${index + 1}</td><td>${htmlEscape(deviceDescription(inspection))}</td><td>${htmlEscape(result.label)}</td></tr>`).join("");
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
