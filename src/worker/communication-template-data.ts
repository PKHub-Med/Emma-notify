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
  EMAIL_VISIBLE_ROW_LIMIT,
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
  inspectionResult: string | null;
  sourceHospitalRecordId: string | null;
  inspectionPerformedAt: Date | null;
  inspectionDueDate: Date | null;
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
        active: true,
        airtableRecordId: { in: [...recordIds] },
      },
      select: {
        airtableRecordId: true,
        businessNumber: true,
        clientOrderNumber: true,
        currentStatus: true,
        inspectionResult: true,
        sourceHospitalRecordId: true,
        inspectionPerformedAt: true,
        inspectionDueDate: true,
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
        inspectionResult: record.inspectionResult,
        sourceHospitalRecordId: record.sourceHospitalRecordId,
        inspectionPerformedAt: record.inspectionPerformedAt,
        inspectionDueDate: record.inspectionDueDate,
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
      where: { airtableRecordId: { in: [...recordIds] }, active: true },
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

export type CommunicationBlockDiagnostic = {
  code: string;
  expected?: unknown;
  found?: unknown;
  recordIds?: readonly string[];
  safeRecordIds?: readonly string[];
  failedAttemptCount?: number;
};

export function buildBlockedClientFallbackPayload(input: {
  deliveries: readonly TemplateDelivery[];
  secureUrl: string;
  unsubscribeUrl: string;
  preparedAt: Date;
  timeZone: string;
  error: CommunicationTemplateDataError;
}): CommunicationTemplatePayload {
  const delivery = input.deliveries[0];
  if (!delivery) throw new Error("BLOCKED_FALLBACK_DELIVERY_MISSING");
  const scenario = delivery.scenario;
  const snapshot = object(delivery.eventSnapshot);
  const diagnostic = input.error.diagnostic;
  const notice = blockedNotice({
    code: input.error.code,
    scenario,
    sourceRecordIds: input.deliveries.map((item) => item.sourceRecordId),
    expected: diagnostic?.expected,
    found: diagnostic?.found,
    ...(diagnostic?.recordIds ? { recordIds: diagnostic.recordIds } : {}),
    ...(diagnostic?.failedAttemptCount !== undefined
      ? { failedAttemptCount: diagnostic.failedAttemptCount } : {}),
    preparedAt: input.preparedAt,
  });
  const common = {
    ...commonVariables(input.preparedAt, input.timeZone, input.secureUrl,
      input.unsubscribeUrl, scenario),
    BLOCKED_NOTICE: notice,
    TRUNCATION_NOTICE: "",
  };
  if (isRepairScenario(scenario)) {
    const safeIds = diagnostic?.safeRecordIds
      ? new Set(diagnostic.safeRecordIds)
      : new Set(input.deliveries.map((item) => item.sourceRecordId));
    const safeSnapshots = input.deliveries
      .filter((item) => safeIds.has(item.sourceRecordId))
      .map((item) => object(item.eventSnapshot));
    const safeRows = safeSnapshots.flatMap((item) => {
      const device = object(item.device);
      const caseNumber = clean(item.businessNumber);
      const deviceName = clean(device.name);
      if (!caseNumber || !deviceName) return [];
      return [{
        caseNumber,
        clientOrderNumber: display(item.clientOrderNumber, "brak numeru"),
        reportedAt: formatSourceDate(item.reportedAtRaw, item.reportedAt,
          input.timeZone, "—", false),
        completedAt: formatOptionalDate(item.completedAt, input.timeZone, "—", false),
        department: display(item.department, "—"),
        deviceName,
        manufacturer: display(device.manufacturer, "—"),
        model: display(device.model, "—"),
        serialNumber: display(device.serialNumber, "brak danych"),
        inventoryNumber: display(device.inventoryNumber, "brak danych"),
        repairStatus: display(item.emmaCustomerStatus ?? item.currentStatus, "Brak informacji"),
        deviceStatus: "Brak danych",
      }];
    });
    return {
      templateId: templateAliasForScenario(scenario),
      variables: {
        ...common,
        EMAIL_TITLE: "EMMA — wiadomość wymaga ręcznej obsługi",
        REPAIR_COUNT: input.deliveries.length,
        ...rowSlotVariables("REPAIR_ROW",
          repairRows(safeRows, scenario).slice(0, EMAIL_VISIBLE_ROW_LIMIT),
          REPAIR_ROW_SLOT_COUNT),
        CASE_NUMBER: display(snapshot.businessNumber, "—"),
        CLIENT_ORDER_NUMBER: display(snapshot.clientOrderNumber, "—"),
        REPORTED_AT: "—", COMPLETED_AT: "—",
        DEVICE_NAME: "Dane bezpieczne dostępne w diagnostyce",
        MANUFACTURER_MODEL: "—", SERIAL_NUMBER: "—", INVENTORY_NUMBER: "—",
        REPAIR_STATUS: display(snapshot.emmaCustomerStatus ?? snapshot.currentStatus, "—"),
        DEVICE_STATUS: "—",
      },
    };
  }
  const visitDate = formatVisitDate(snapshot.day) ?? "—";
  const base = {
    ...common,
    VISIT_DATE: visitDate,
    DEPARTMENT: display(snapshot.department, "—"),
    DEVICE_COUNT: stringArray(snapshot.linkedInspectionRecordIds).length,
  };
  if (scenario === CommunicationScenario.INSPECTION_COMPLETED) {
    return { templateId: templateAliasForScenario(scenario), variables: {
      ...base, PASSED_COUNT: "0", CONDITIONAL_COUNT: "0", FAILED_COUNT: "0",
      ...rowSlotVariables("RESULT_ROW", [], INSPECTION_ROW_SLOT_COUNT),
    } };
  }
  const variables: Record<string, TemplateVariableValue> = {
    ...base,
    ...rowSlotVariables("DEVICE_ROW", [], INSPECTION_ROW_SLOT_COUNT),
  };
  if (scenario === CommunicationScenario.INSPECTION_DATE_PROPOSED) {
    Object.assign(variables, {
      COORDINATOR_NAME: "Tiemed", COORDINATOR_PHONE: "—",
      COORDINATOR_EMAIL: "serwis@tiemed.pl", COORDINATOR_REPLY_URL: "mailto:serwis@tiemed.pl",
    });
  }
  if (scenario === CommunicationScenario.INSPECTION_REMINDER) {
    Object.assign(variables, {
      TECHNICIAN_NAME: "Tiemed", TECHNICIAN_PHONE: "—",
      TECHNICIAN_PHONE_TEL: "", TECHNICIAN_EMAIL: "—",
    });
  }
  return { templateId: templateAliasForScenario(scenario), variables };
}

export class CommunicationTemplateDataError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly diagnostic?: CommunicationBlockDiagnostic,
  ) {
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
  const expectedInspectionIds = stringArray(snapshot.linkedInspectionRecordIds);
  try {
    inspections = await input.dataSource.getInspections(
      expectedInspectionIds,
    );
  } catch {
    throw new CommunicationTemplateDataError("TEMPLATE_DATA_SOURCE_ERROR", true);
  }

  const foundIds = new Set(inspections.map((inspection) => inspection.airtableRecordId));
  const missingIds = expectedInspectionIds.filter((id) => !foundIds.has(id));
  if (missingIds.length > 0 || inspections.length !== expectedInspectionIds.length) {
    throw new CommunicationTemplateDataError("INSPECTION_SET_INCOMPLETE", false, {
      code: "INSPECTION_SET_INCOMPLETE",
      expected: expectedInspectionIds.length,
      found: inspections.length,
      recordIds: missingIds,
      safeRecordIds: inspections.map((inspection) => inspection.airtableRecordId),
    });
  }

  const expectedHospital = clean(snapshot.sourceHospitalRecordId);
  const scopeMismatch = inspections.find((inspection) =>
    !expectedHospital || inspection.sourceHospitalRecordId !== expectedHospital);
  if (scopeMismatch) {
    throw new CommunicationTemplateDataError("INSPECTION_HOSPITAL_SCOPE_MISMATCH", false, {
      code: "INSPECTION_HOSPITAL_SCOPE_MISMATCH",
      expected: expectedHospital || null,
      found: scopeMismatch.sourceHospitalRecordId,
      recordIds: [scopeMismatch.airtableRecordId],
      safeRecordIds: inspections
        .filter((inspection) => inspection.sourceHospitalRecordId === expectedHospital)
        .map((inspection) => inspection.airtableRecordId),
    });
  }

  const inconsistent = inspections.find(isInspectionStateInconsistent);
  if (inconsistent) {
    throw new CommunicationTemplateDataError("INSPECTION_STATE_INCONSISTENT", false, {
      code: "INSPECTION_STATE_INCONSISTENT",
      expected: "completed status for performed inspection",
      found: {
        currentStatus: inconsistent.currentStatus,
        performedAt: inconsistent.inspectionPerformedAt?.toISOString() ?? null,
        dueDate: inconsistent.inspectionDueDate?.toISOString() ?? null,
        inspectionResult: inconsistent.inspectionResult,
      },
      recordIds: [inconsistent.airtableRecordId],
      safeRecordIds: inspections.filter((inspection) => inspection !== inconsistent)
        .map((inspection) => inspection.airtableRecordId),
    });
  }

  if (input.delivery.scenario === CommunicationScenario.INSPECTION_COMPLETED) {
    const classified = inspections
      .map((inspection) => ({
        inspection,
        result: inspectionResult(inspection.inspectionResult),
      }));
    const unrecognized = classified.filter((item) => item.result === null);
    if (unrecognized.length > 0) {
      throw new CommunicationTemplateDataError("INSPECTION_RESULT_INCOMPLETE", false, {
        code: "INSPECTION_RESULT_INCOMPLETE",
        expected: { expectedCount: inspections.length, recognizedCount: inspections.length - unrecognized.length },
        found: unrecognized.map(({ inspection }) => ({
          taskId: input.delivery.sourceRecordId,
          inspectionRecordId: inspection.airtableRecordId,
          rawInspectionResult: inspection.inspectionResult,
        })),
        recordIds: unrecognized.map(({ inspection }) => inspection.airtableRecordId),
        safeRecordIds: classified.filter((item) => item.result !== null)
          .map(({ inspection }) => inspection.airtableRecordId),
      });
    }
    const completed = classified
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
        BLOCKED_NOTICE: "",
        VISIT_DATE: visitDate,
        PASSED_COUNT: count("WORKING"),
        CONDITIONAL_COUNT: count("CONDITIONAL"),
        FAILED_COUNT: count("DEFECTIVE"),
        TRUNCATION_NOTICE: truncationNotice(completed.length, "urządzeń", "przeglądy"),
        ...rowSlotVariables("RESULT_ROW", resultRows(completed).slice(0, EMAIL_VISIBLE_ROW_LIMIT), INSPECTION_ROW_SLOT_COUNT),
      },
    };
  }

  const base = {
    ...common,
    BLOCKED_NOTICE: "",
    VISIT_DATE: visitDate,
    DEPARTMENT: display(
      snapshot.department ?? snapshot.caseLocation ?? snapshot.hospitalName,
      "—",
    ),
    DEVICE_COUNT: inspections.length,
    TRUNCATION_NOTICE: truncationNotice(inspections.length, "urządzeń", "przeglądy"),
    ...rowSlotVariables("DEVICE_ROW", deviceRows(inspections).slice(0, EMAIL_VISIBLE_ROW_LIMIT), INSPECTION_ROW_SLOT_COUNT),
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
      reportedAt: formatSourceDate(
        snapshot.reportedAtRaw,
        snapshot.reportedAt,
        input.timeZone,
        "—",
        false,
      ),
      completedAt: formatOptionalDate(
        snapshot.completedAt,
        input.timeZone,
        "—",
        false,
      ),
      department: display(snapshot.department, "—"),
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
      : scenario === CommunicationScenario.REPAIR_DELAYED_PARTS
        ? `Naprawa oczekuje na części · ${first.deviceName} · ${first.caseNumber}`
        : `Naprawa zakończona · ${first.deviceName} · ${first.serialNumber} · ${first.clientOrderNumber}`
    : scenario === CommunicationScenario.REPAIR_RECEIVED
      ? `Przyjęliśmy ${rows.length} zgłoszenia serwisowe`
      : scenario === CommunicationScenario.REPAIR_DELAYED_PARTS
        ? `Naprawy oczekujące na części · ${rows.length} spraw`
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
      BLOCKED_NOTICE: "",
      REPAIR_COUNT: rows.length,
      TRUNCATION_NOTICE: truncationNotice(rows.length, "napraw", "naprawy"),
      ...rowSlotVariables("REPAIR_ROW", repairRows(rows, scenario).slice(0, EMAIL_VISIBLE_ROW_LIMIT), REPAIR_ROW_SLOT_COUNT),
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
    EMMA_SECURE_URL: buildSecureCtaHtml(secureUrl, scenario),
    EMMA_UNSUBSCRIBE_URL: buildUnsubscribeHtml(unsubscribeUrl),
  };
}

export function buildSecureCtaHtml(secureUrl: string, scenario: CommunicationScenario): string {
  if (!secureUrl) return "";
  const url = `${secureUrl}${isRepairScenario(scenario) ? "#repairs" : "#inspections"}`;
  const label = isRepairScenario(scenario) ? "Zobacz naprawy w Emma" : "Zobacz przeglądy w Emma";
  return `<a href="${htmlEscape(url)}" style="display:inline-block;margin-top:16px;padding:12px 18px;border-radius:8px;background:#223F6D;color:#fff;text-decoration:none;font-size:14px;line-height:20px;font-weight:800;">${label}</a>`;
}

export function buildUnsubscribeHtml(unsubscribeUrl: string): string {
  if (!unsubscribeUrl) return "";
  return `<span style="display:block;margin-top:4px;">Nie chcesz otrzymywać takich powiadomień? <a href="${htmlEscape(unsubscribeUrl)}" style="color:#66758A;text-decoration:underline;">Wyłącz otrzymywanie tych maili</a>.</span>`;
}

function deviceRows(inspections: TemplateInspection[]): string[] {
  return inspections.map((inspection, index) => {
    const bottomBorder = index < inspections.length - 1
      ? "border-bottom:1px solid #D9E1EB;"
      : "";
    const details = [
      `<div style="font-size:14px;line-height:20px;font-weight:800;color:#1F2F49;">${htmlEscape(display(inspection.deviceName, "Urządzenie"))}</div>`,
      `<div style="margin-top:3px;font-size:12px;line-height:18px;color:#34445D;">${htmlEscape(display(inspection.manufacturer, "—"))} &#183; ${htmlEscape(display(inspection.model, "—"))}</div>`,
      `<div style="margin-top:4px;font-size:12px;line-height:18px;color:#66758A;">SN: ${htmlEscape(display(inspection.serialNumber, "—"))} &#183; Nr inw.: ${htmlEscape(display(inspection.inventoryNumber, "—"))}<br>Numer sprawy: ${htmlEscape(display(inspection.businessNumber, "—"))}<br>Nr zlecenia klienta: ${htmlEscape(display(inspection.clientOrderNumber, "brak numeru"))}</div>`,
    ].join("");

    return `<tr><td style="padding:13px 8px;${bottomBorder}border-right:1px solid #D9E1EB;text-align:center;vertical-align:middle;font-size:12px;line-height:18px;color:#34445D;">${index + 1}</td><td style="padding:13px 12px;${bottomBorder}border-right:1px solid #D9E1EB;vertical-align:top;">${details}</td><td style="padding:13px 8px;${bottomBorder}text-align:center;vertical-align:middle;font-size:12px;line-height:18px;font-weight:700;color:#1F2F49;white-space:nowrap;">${htmlEscape(formatDuration(inspection.estimatedDurationSeconds))}</td></tr>`;
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
    department: string;
  }>,
  scenario: CommunicationScenario,
): string[] {
  return items.map((item, index) => {
    const bottomBorder = index < items.length - 1
      ? "border-bottom:1px solid #D9E1EB;"
      : "";
    const date = scenario === CommunicationScenario.REPAIR_RECEIVED ||
        scenario === CommunicationScenario.REPAIR_DELAYED_PARTS
      ? item.reportedAt
      : item.completedAt;

    const statuses = scenario === CommunicationScenario.REPAIR_COMPLETED
      ? `<div style="margin-top:9px;">${statusBadge(item.repairStatus, repairStatusTone(item.repairStatus))}<span style="display:inline-block;width:5px;">&nbsp;</span>${statusBadge(`Urządzenie: ${item.deviceStatus}`, deviceStatusTone(item.deviceStatus))}</div>`
      : "";

    const waiting = scenario === CommunicationScenario.REPAIR_DELAYED_PARTS
      ? `<div style="margin-top:9px;font-size:12px;line-height:18px;color:#8B6117;font-weight:700;">Oczekiwanie na części. Kolejna informacja pojawi się po zmianie statusu.</div>`
      : "";
    const details = `<div style="font-size:14px;line-height:20px;font-weight:800;color:#1F2F49;">${htmlEscape(item.deviceName)}</div><div style="margin-top:3px;font-size:12px;line-height:18px;color:#34445D;">${htmlEscape(item.manufacturer)} &#183; ${htmlEscape(item.model)}</div><div style="margin-top:4px;font-size:12px;line-height:18px;color:#66758A;">SN: ${htmlEscape(item.serialNumber)} &#183; Nr inw.: ${htmlEscape(item.inventoryNumber)}<br>Oddział: ${htmlEscape(item.department)}<br>Numer sprawy: ${htmlEscape(item.caseNumber)}<br>Nr zlecenia klienta: ${htmlEscape(item.clientOrderNumber)}</div>${statuses}${waiting}`;

    return `<tr><td style="padding:14px 8px;${bottomBorder}border-right:1px solid #D9E1EB;text-align:center;vertical-align:middle;font-size:12px;line-height:18px;color:#34445D;">${index + 1}</td><td style="padding:14px 12px;${bottomBorder}border-right:1px solid #D9E1EB;vertical-align:top;">${details}</td><td style="padding:14px 10px;${bottomBorder}text-align:center;vertical-align:middle;font-size:12px;line-height:18px;font-weight:700;color:#1F2F49;white-space:nowrap;">${htmlEscape(date)}</td></tr>`;
  });
}

function resultRows(
  items: Array<{ inspection: TemplateInspection; result: InspectionResult }>,
): string[] {
  return items.map(({ inspection, result }, index) => {
    const bottomBorder = index < items.length - 1
      ? "border-bottom:1px solid #D9E1EB;"
      : "";
    const details = `<div style="font-size:14px;line-height:20px;font-weight:800;color:#1F2F49;">${htmlEscape(display(inspection.deviceName, "Urządzenie"))}</div><div style="margin-top:3px;font-size:12px;line-height:18px;color:#34445D;">${htmlEscape(display(inspection.manufacturer, "—"))} &#183; ${htmlEscape(display(inspection.model, "—"))}</div><div style="margin-top:4px;font-size:12px;line-height:18px;color:#66758A;">SN: ${htmlEscape(display(inspection.serialNumber, "—"))} &#183; Nr inw.: ${htmlEscape(display(inspection.inventoryNumber, "—"))}<br>Numer sprawy: ${htmlEscape(display(inspection.businessNumber, "—"))}<br>Nr zlecenia klienta: ${htmlEscape(display(inspection.clientOrderNumber, "brak numeru"))}</div>`;
    return `<tr><td style="padding:13px 8px;${bottomBorder}border-right:1px solid #D9E1EB;text-align:center;vertical-align:middle;font-size:12px;line-height:18px;color:#34445D;">${index + 1}</td><td style="padding:13px 12px;${bottomBorder}border-right:1px solid #D9E1EB;vertical-align:top;">${details}</td><td style="padding:13px 10px;${bottomBorder}border-right:1px solid #D9E1EB;text-align:center;vertical-align:middle;">${statusBadge(result.label, inspectionResultTone(result.key))}</td><td style="padding:13px 8px;${bottomBorder}text-align:center;vertical-align:middle;font-size:12px;line-height:18px;font-weight:700;color:#1F2F49;white-space:nowrap;">${htmlEscape(formatDuration(inspection.estimatedDurationSeconds))}</td></tr>`;
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
  return `<span style="display:inline-block;padding:5px 8px;border-radius:999px;border:1px solid ${tone.border};background:${tone.background};color:${tone.color};font-size:12px;line-height:18px;font-weight:800;white-space:nowrap;">${htmlEscape(label)}</span>`;
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
  if (seconds === null || seconds < 0) return "-";
  if (seconds < 60) return `${Math.round(seconds)} s`;

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} godz.` : `${hours} godz. ${rest} min`;
}

function isRepairScenario(scenario: CommunicationScenario): boolean {
  return scenario === CommunicationScenario.REPAIR_RECEIVED ||
    scenario === CommunicationScenario.REPAIR_DELAYED_PARTS ||
    scenario === CommunicationScenario.REPAIR_COMPLETED;
}

export function formatSourceDate(
  rawValue: unknown,
  timestampValue: unknown,
  timeZone: string,
  fallback: string,
  includeTime = true,
): string {
  if (typeof rawValue === "string" && /^\d{4}-\d{2}-\d{2}$/.test(rawValue.trim())) {
    const [year, month, day] = rawValue.trim().split("-");
    return `${day}.${month}.${year}`;
  }
  return formatOptionalDate(timestampValue, timeZone, fallback, includeTime);
}

export function isInspectionStateInconsistent(inspection: Pick<TemplateInspection,
  "currentStatus" | "inspectionPerformedAt">): boolean {
  if (!inspection.inspectionPerformedAt) return false;
  const status = inspection.currentStatus?.trim().toUpperCase() ?? "";
  return /^(DO REALIZACJI|DO WYKONANIA|PLANOWAN|ZAPLANOWAN)/.test(status);
}

function truncationNotice(total: number, noun: string, section: string): string {
  if (total <= EMAIL_VISIBLE_ROW_LIMIT) return "";
  return `<div style="margin:20px 0;padding:16px;border:2px solid #C96B1A;border-radius:10px;background:#FFF3E8;color:#713B0C;font-size:14px;line-height:20px;"><strong style="display:block;font-size:15px;">TO NIE JEST PEŁNA LISTA</strong>W wiadomości pokazujemy ${EMAIL_VISIBLE_ROW_LIMIT} z ${total} ${htmlEscape(noun)}. Pełna lista jest dostępna w sekcji ${htmlEscape(section)} w Emma.</div>`;
}

function blockedNotice(input: {
  code: string;
  scenario: CommunicationScenario;
  sourceRecordIds: readonly string[];
  expected: unknown;
  found: unknown;
  recordIds?: readonly string[];
  failedAttemptCount?: number;
  preparedAt: Date;
}): string {
  const lines = [
    "Wiadomość nie została wysłana do klienta.",
    `Scenariusz: ${input.scenario}`,
    `Kod błędu: ${input.code}`,
    `Źródło: ${input.sourceRecordIds.join(", ")}`,
    input.recordIds?.length ? `Rekordy: ${input.recordIds.join(", ")}` : "",
    input.failedAttemptCount !== undefined
      ? `Liczba nieudanych prób: ${input.failedAttemptCount}` : "",
    input.expected !== undefined ? `Oczekiwano: ${safeDiagnostic(input.expected)}` : "",
    input.found !== undefined ? `Znaleziono: ${safeDiagnostic(input.found)}` : "",
    `Timestamp: ${input.preparedAt.toISOString()}`,
  ].filter(Boolean);
  return `<div style="margin:0 0 20px;padding:18px;border:3px solid #A33A3A;border-radius:10px;background:#FFF0F0;color:#6F2020;font-size:14px;line-height:21px;"><strong style="display:block;font-size:17px;">EMMA — WIADOMOŚĆ WYMAGA RĘCZNEJ OBSŁUGI</strong>${lines.map((line) => `<div>${htmlEscape(line)}</div>`).join("")}</div>`;
}

function safeDiagnostic(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  try { return JSON.stringify(value); } catch { return "[unavailable]"; }
}
