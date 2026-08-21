import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { CommunicationScenario } from "../generated/prisma/enums.js";
import {
  COMMUNICATION_TEMPLATE_ALIASES,
  INSPECTION_ROW_SLOT_COUNT,
  REPAIR_ROW_SLOT_COUNT,
  TEMPLATE_STRING_VALUE_MAX_LENGTH,
  templateRowSlotKey,
} from "./communication-template-registry.js";
import {
  buildBlockedClientFallbackPayload,
  buildCommunicationRepairBatchPayload,
  buildCommunicationTemplatePayload,
  CommunicationTemplateDataError,
  formatSourceDate,
  type CommunicationTemplateDataSource,
  type TemplateEmployee,
  type TemplateInspection,
} from "./communication-template-data.js";

const preparedAt = new Date("2026-08-15T10:00:00Z");
const secureUrl = "https://notify.example.org/p/signed-token";
const unsubscribeUrl = "https://notify.example.org/u/signed-token";

const repairRowKeys = slotKeys("REPAIR_ROW", REPAIR_ROW_SLOT_COUNT);
const deviceRowKeys = slotKeys("DEVICE_ROW", INSPECTION_ROW_SLOT_COUNT);
const resultRowKeys = slotKeys("RESULT_ROW", INSPECTION_ROW_SLOT_COUNT);
const linkKeys = ["EMMA_SECURE_URL","EMMA_UNSUBSCRIBE_URL"];

const repairKeys = [
  "SERVICE_NAME","SENT_AT","EMAIL_TITLE","REPAIR_COUNT","BLOCKED_NOTICE","TRUNCATION_NOTICE",...repairRowKeys,
  "CASE_NUMBER","CLIENT_ORDER_NUMBER","REPORTED_AT","COMPLETED_AT","DEVICE_NAME",
  "MANUFACTURER_MODEL","SERIAL_NUMBER","INVENTORY_NUMBER","REPAIR_STATUS",
  "DEVICE_STATUS",...linkKeys,
];
const expectedKeys: Record<CommunicationScenario, string[]> = {
  REPAIR_RECEIVED: repairKeys,
  REPAIR_DELAYED_PARTS: repairKeys,
  REPAIR_COMPLETED: repairKeys,
  INSPECTION_DATE_CONFIRMED: ["SERVICE_NAME","SENT_AT","VISIT_DATE","DEPARTMENT","DEVICE_COUNT","BLOCKED_NOTICE","TRUNCATION_NOTICE",...deviceRowKeys,...linkKeys],
  INSPECTION_DATE_PROPOSED: ["SERVICE_NAME","SENT_AT","VISIT_DATE","DEPARTMENT","DEVICE_COUNT","BLOCKED_NOTICE","TRUNCATION_NOTICE","COORDINATOR_NAME","COORDINATOR_PHONE","COORDINATOR_EMAIL","COORDINATOR_REPLY_URL",...deviceRowKeys,...linkKeys],
  INSPECTION_REMINDER: ["SERVICE_NAME","SENT_AT","VISIT_DATE","DEPARTMENT","DEVICE_COUNT","BLOCKED_NOTICE","TRUNCATION_NOTICE","TECHNICIAN_NAME","TECHNICIAN_PHONE","TECHNICIAN_PHONE_TEL","TECHNICIAN_EMAIL",...deviceRowKeys,...linkKeys],
  INSPECTION_COMPLETED: ["SERVICE_NAME","SENT_AT","VISIT_DATE","PASSED_COUNT","CONDITIONAL_COUNT","FAILED_COUNT","BLOCKED_NOTICE","TRUNCATION_NOTICE",...resultRowKeys,...linkKeys],
};

describe("published communication template registry", () => {
  it("maps all seven active scenarios including delayed parts", () => {
    expect(COMMUNICATION_TEMPLATE_ALIASES).toEqual({
      REPAIR_RECEIVED: "emma-repair-received", REPAIR_COMPLETED: "emma-repair-completed",
      REPAIR_DELAYED_PARTS: "emma-repair-delayed-parts-phase1",
      INSPECTION_DATE_CONFIRMED: "emma-inspection-confirmed", INSPECTION_DATE_PROPOSED: "emma-inspection-proposed",
      INSPECTION_REMINDER: "emma-inspection-reminder", INSPECTION_COMPLETED: "emma-inspection-summary",
    });
    expect(Object.values(COMMUNICATION_TEMPLATE_ALIASES)).toContain("emma-repair-delayed-parts-phase1");
  });

  it.each(Object.values(CommunicationScenario))("uses exact variable contract for %s", async (scenario) => {
    const payload = await build(scenario);
    expect(payload.templateId).toBe(COMMUNICATION_TEMPLATE_ALIASES[scenario]);
    expect(Object.keys(payload.variables).sort()).toEqual([...expectedKeys[scenario]].sort());
    expect(Object.values(payload.variables).every((value) => value !== undefined && value !== null)).toBe(true);
    expect(payload.variables.EMMA_SECURE_URL).toContain(
      scenario.startsWith("REPAIR") ? `${secureUrl}#repairs` : `${secureUrl}#inspections`,
    );
    expect(payload.variables.EMMA_UNSUBSCRIBE_URL).toContain(unsubscribeUrl);
  });

  it("keeps every string template variable within the Resend per-value limit", async () => {
    for (const scenario of Object.values(CommunicationScenario)) {
      const payload = await build(scenario);
      for (const value of Object.values(payload.variables)) {
        if (typeof value === "string") expect(value.length).toBeLessThanOrEqual(TEMPLATE_STRING_VALUE_MAX_LENGTH);
      }
    }
  });

  it("keeps numeric counters numeric for Resend", async () => {
    const dataSource: CommunicationTemplateDataSource = {
      async getEmployees() { return []; },
      async getDevices() { return []; },
      async getInspections() {
        return Array.from({ length: 15 }, (_, index) =>
          inspection(`inspection-${index}`, "SPRAWNY"));
      },
    };
    for (const scenario of [
      CommunicationScenario.INSPECTION_DATE_CONFIRMED,
      CommunicationScenario.INSPECTION_DATE_PROPOSED,
      CommunicationScenario.INSPECTION_REMINDER,
    ]) {
      const payload = await buildCommunicationTemplatePayload({
        delivery: { id: "delivery", scenario, sourceRecordId: "source", eventSnapshot: {
          ...taskSnapshot(), linkedInspectionRecordIds: Array.from({ length: 15 }, (_, index) => `inspection-${index}`),
        } },
        dataSource, secureUrl, unsubscribeUrl, preparedAt, timeZone: "Europe/Warsaw",
      });
      expect(payload.variables.DEVICE_COUNT).toBe(15);
      expect(typeof payload.variables.DEVICE_COUNT).toBe("number");
    }
    const repair = await build(CommunicationScenario.REPAIR_RECEIVED);
    expect(repair.variables.REPAIR_COUNT).toBe(1);
    expect(typeof repair.variables.REPAIR_COUNT).toBe("number");
  });
});

describe("dynamic HTML and source mapping", () => {
  it.each([29, 30, 31, 47])("shows at most 30 of %i inspections but preserves the full count", async (count) => {
    const ids = Array.from({ length: count }, (_, index) => `inspection-${index}`);
    const dataSource: CommunicationTemplateDataSource = {
      async getEmployees() { return []; }, async getDevices() { return []; },
      async getInspections() { return ids.map((id) => inspection(id, "SPRAWNY")); },
    };
    const payload = await buildCommunicationTemplatePayload({
      delivery: { id: "delivery", scenario: CommunicationScenario.INSPECTION_DATE_CONFIRMED,
        sourceRecordId: "task", eventSnapshot: { ...taskSnapshot(), linkedInspectionRecordIds: ids } },
      dataSource, secureUrl, unsubscribeUrl, preparedAt, timeZone: "Europe/Warsaw",
    });
    expect(payload.variables.DEVICE_COUNT).toBe(count);
    expect(String(payload.variables.DEVICE_ROW_30).length > 0).toBe(count >= 30);
    expect(String(payload.variables.TRUNCATION_NOTICE)).toContain(count > 30 ? `30 z ${count}` : "");
  });

  it("uses EMAIL_TITLE as the delayed-parts subject for one and many repairs", async () => {
    const syncScript = readFileSync("scripts/sync-resend-templates.mjs", "utf8");
    const delayedBlock = syncScript.slice(syncScript.indexOf('alias: "emma-repair-delayed-parts-phase1"'));
    expect(delayedBlock.slice(0, delayedBlock.indexOf("},") + 2))
      .toContain('subject: "{{{EMAIL_TITLE}}}"');
    const one = await build(CommunicationScenario.REPAIR_DELAYED_PARTS);
    expect(one.variables.EMAIL_TITLE).toContain("Naprawa oczekuje na części");
    const many = await buildCommunicationRepairBatchPayload({
      deliveries: [
        { id: "one", scenario: CommunicationScenario.REPAIR_DELAYED_PARTS,
          sourceRecordId: "one", eventSnapshot: repairSnapshot() },
        { id: "two", scenario: CommunicationScenario.REPAIR_DELAYED_PARTS,
          sourceRecordId: "two", eventSnapshot: { ...repairSnapshot(), businessNumber: "SO-2" } },
      ],
      dataSource: source(), secureUrl, unsubscribeUrl, preparedAt, timeZone: "Europe/Warsaw",
    });
    expect(many.variables.EMAIL_TITLE).toBe("Naprawy oczekujące na części · 2 spraw");
  });

  it("blocks an incomplete or cross-hospital inspection set", async () => {
    const incomplete = source();
    incomplete.getInspections = async () => inspections().slice(0, 3);
    await expect(buildCommunicationTemplatePayload({ delivery: { id: "d", scenario: CommunicationScenario.INSPECTION_DATE_CONFIRMED,
      sourceRecordId: "task", eventSnapshot: taskSnapshot() }, dataSource: incomplete, secureUrl,
      unsubscribeUrl, preparedAt, timeZone: "Europe/Warsaw" })).rejects.toMatchObject({ code: "INSPECTION_SET_INCOMPLETE" });
    const crossHospital = source();
    crossHospital.getInspections = async () => inspections().map((item, index) =>
      index === 0 ? { ...item, sourceHospitalRecordId: "otherHospital" } : item);
    await expect(buildCommunicationTemplatePayload({ delivery: { id: "d", scenario: CommunicationScenario.INSPECTION_DATE_CONFIRMED,
      sourceRecordId: "task", eventSnapshot: taskSnapshot() }, dataSource: crossHospital, secureUrl,
      unsubscribeUrl, preparedAt, timeZone: "Europe/Warsaw" })).rejects.toMatchObject({ code: "INSPECTION_HOSPITAL_SCOPE_MISMATCH" });
  });

  it("blocks a performed inspection still marked as pre-execution", async () => {
    const dataSource = source();
    dataSource.getInspections = async () => inspections().map((item, index) => index === 0
      ? { ...item, currentStatus: "DO REALIZACJI", inspectionPerformedAt: new Date("2026-08-20T10:00:00Z") } : item);
    await expect(buildCommunicationTemplatePayload({ delivery: { id: "d", scenario: CommunicationScenario.INSPECTION_COMPLETED,
      sourceRecordId: "task", eventSnapshot: taskSnapshot() }, dataSource, secureUrl,
      unsubscribeUrl, preparedAt, timeZone: "Europe/Warsaw" })).rejects.toMatchObject({ code: "INSPECTION_STATE_INCONSISTENT" });
  });

  it.each([null, "NIEZNANY WYNIK"])("blocks the whole summary for an unrecognized result: %s", async (raw) => {
    const dataSource = source();
    dataSource.getInspections = async () => [
      inspection("good", "SPRAWNY"),
      inspection("bad", "NIESPRAWNY"),
      { ...inspection("missing", "ZAKOŃCZONY"), inspectionResult: raw },
    ];
    const promise = buildCommunicationTemplatePayload({
      delivery: { id: "d", scenario: CommunicationScenario.INSPECTION_COMPLETED,
        sourceRecordId: "task-3", eventSnapshot: { ...taskSnapshot(),
          linkedInspectionRecordIds: ["good", "bad", "missing"] } },
      dataSource, secureUrl, unsubscribeUrl, preparedAt, timeZone: "Europe/Warsaw",
    });
    await expect(promise).rejects.toMatchObject({
      code: "INSPECTION_RESULT_INCOMPLETE",
      diagnostic: { recordIds: ["missing"] },
    });
    await expect(promise).rejects.toThrow("INSPECTION_RESULT_INCOMPLETE");
  });

  it("keeps safe repair rows in a blocked batch and hides links without grants", () => {
    const payload = buildBlockedClientFallbackPayload({
      deliveries: [
        { id: "a", scenario: CommunicationScenario.REPAIR_RECEIVED,
          sourceRecordId: "repair-a", eventSnapshot: repairSnapshot() },
        { id: "b", scenario: CommunicationScenario.REPAIR_RECEIVED,
          sourceRecordId: "repair-b", eventSnapshot: { ...repairSnapshot(), businessNumber: "SO-B",
            device: { ...repairSnapshot().device, name: "Bezpieczna pompa" } } },
        { id: "c", scenario: CommunicationScenario.REPAIR_RECEIVED,
          sourceRecordId: "repair-c", eventSnapshot: { ...repairSnapshot(), businessNumber: "FOREIGN" } },
      ], secureUrl: "", unsubscribeUrl: "", preparedAt, timeZone: "Europe/Warsaw",
      error: new CommunicationTemplateDataError("REPAIR_HOSPITAL_SCOPE_MISMATCH", false, {
        code: "REPAIR_HOSPITAL_SCOPE_MISMATCH", recordIds: ["repair-c"],
        safeRecordIds: ["repair-a", "repair-b"],
      }),
    });
    expect(payload.variables.REPAIR_ROW_01).toContain("Aparat HFNOT");
    expect(payload.variables.REPAIR_ROW_02).toContain("Bezpieczna pompa");
    expect(JSON.stringify(payload.variables)).not.toContain("FOREIGN");
    expect(payload.variables).toMatchObject({ EMMA_SECURE_URL: "", EMMA_UNSUBSCRIBE_URL: "" });
  });

  it("preserves date-only precision and formats full timestamps in Warsaw", () => {
    expect(formatSourceDate("2026-08-19", "2026-08-19T00:00:00Z", "Europe/Warsaw", "—")).toBe("19.08.2026");
    expect(formatSourceDate("2026-08-19T12:55:00Z", "2026-08-19T12:55:00Z", "Europe/Warsaw", "—")).toContain("14:55");
  });
  it("uses inspection snapshot fields, escapes HTML and includes per-device duration", async () => {
    const variables = (await build(CommunicationScenario.INSPECTION_DATE_CONFIRMED)).variables;
    const row = String(variables.DEVICE_ROW_01);
    expect(row).toContain("Łóżko &lt;OIOM&gt;");
    expect(row).toContain("Żółty Medical &#183; Przegląd · 2");
    expect(row).toContain("Nr zlecenia klienta: ADZP-381-353/25");
    expect(row).toContain("Numer sprawy: 25793");
    expect(row).toContain("12 min");
    expect(row).toContain("border-right:1px solid #D9E1EB");
    expect(row).toContain("font-size:12px");
    expect(row).toContain("&#183;");
    expect(row).not.toContain("Ă‚Â·");
  });

  it.each([
    [1800, "30 min"], [3600, "1 godz."], [5400, "1 godz. 30 min"], [null, "-"],
  ])("formats inspection duration %j consistently in device and result rows", async (seconds, expected) => {
    const one = { ...inspection("only", "SPRAWNY"), estimatedDurationSeconds: seconds };
    const dataSource: CommunicationTemplateDataSource = {
      async getEmployees() { return []; }, async getDevices() { return []; },
      async getInspections() { return [one]; },
    };
    for (const scenario of [
      CommunicationScenario.INSPECTION_DATE_PROPOSED,
      CommunicationScenario.INSPECTION_DATE_CONFIRMED,
      CommunicationScenario.INSPECTION_REMINDER,
      CommunicationScenario.INSPECTION_COMPLETED,
    ]) {
      const payload = await buildCommunicationTemplatePayload({
        delivery: { id: "d", scenario, sourceRecordId: "task",
          eventSnapshot: { ...taskSnapshot(), linkedInspectionRecordIds: ["only"] } },
        dataSource, secureUrl, unsubscribeUrl, preparedAt, timeZone: "Europe/Warsaw",
      });
      const row = String(scenario === CommunicationScenario.INSPECTION_COMPLETED
        ? payload.variables.RESULT_ROW_01 : payload.variables.DEVICE_ROW_01);
      expect(row).toContain(`>${expected}</td></tr>`);
    }
  });

  it("renders repair dates in a separate column and completed statuses as colored badges", async () => {
    const received = String((await build(CommunicationScenario.REPAIR_RECEIVED)).variables.REPAIR_ROW_01);
    expect(received).toContain("16.06.2026</td></tr>");
    expect(received).toContain("border-right:1px solid #D9E1EB");
    expect(received).toContain("font-size:12px");
    expect(received).not.toContain("Data zgłoszenia:");

    const completed = String((await build(CommunicationScenario.REPAIR_COMPLETED)).variables.REPAIR_ROW_01);
    expect(completed).toContain("23.07.2026</td></tr>");
    expect(completed).toContain(">Naprawa zakończona</span>");
    expect(completed).toContain("Urządzenie: Brak danych");
    expect(completed).toContain("border-radius:999px");
    expect(completed).not.toContain("Data zakończenia:");
  });

  it("sorts completed inspection results problem-first and renders status badges", async () => {
    const variables = (await build(CommunicationScenario.INSPECTION_COMPLETED)).variables;
    expect(variables).toMatchObject({ FAILED_COUNT: "1", CONDITIONAL_COUNT: "1", PASSED_COUNT: "2" });
    const rows = resultRowKeys.map((key) => String(variables[key] ?? "")).join("");
    expect(rows.indexOf("NIESPRAWNY")).toBeLessThan(rows.indexOf("WARUNKOWO DOPUSZCZONY"));
    expect(rows).toContain("border-radius:999px");
    expect(rows).toContain("Numer sprawy: 25793");
    expect(rows).toContain("Nr zlecenia klienta: ADZP-381-353/25");
  });

  it("always uses the first task performer, including that employee email", async () => {
    const variables = (await build(CommunicationScenario.INSPECTION_REMINDER)).variables;
    expect(variables).toMatchObject({
      TECHNICIAN_NAME: "Pierwszy Serwisant",
      TECHNICIAN_PHONE: "—",
      TECHNICIAN_PHONE_TEL: "",
      TECHNICIAN_EMAIL: "pierwszy@tiemed.pl",
    });
  });

  it("uses office contact for proposed visits instead of a technician", async () => {
    const payload = await buildCommunicationTemplatePayload({
      delivery: {
        id: "delivery", scenario: CommunicationScenario.INSPECTION_DATE_PROPOSED,
        sourceRecordId: "source", eventSnapshot: taskSnapshot(),
      },
      dataSource: source(), secureUrl, unsubscribeUrl, preparedAt,
      timeZone: "Europe/Warsaw",
      officeContact: { name: "Biuro Tiemed", phone: "+48 123 456 789", email: "serwis@tiemed.pl" },
    });
    expect(payload.variables).toMatchObject({
      COORDINATOR_NAME: "Biuro Tiemed",
      COORDINATOR_PHONE: "+48 123 456 789",
      COORDINATOR_EMAIL: "serwis@tiemed.pl",
    });
  });

  it("uses reportedAt and keeps device status separate from repair status", async () => {
    const variables = (await build(CommunicationScenario.REPAIR_COMPLETED)).variables;
    expect(variables.REPORTED_AT).toBe("16.06.2026");
    expect(variables.REPAIR_STATUS).toBe("Naprawa zakończona");
    expect(variables.DEVICE_STATUS).toBe("Brak danych");
    expect(variables.EMAIL_TITLE).toContain("Aparat HFNOT · 250939J8H · DAM.224.0582/26.DSK.JK, PS508436");
  });
});

function slotKeys(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => templateRowSlotKey(prefix, index));
}

async function build(scenario: CommunicationScenario) {
  return buildCommunicationTemplatePayload({
    delivery: {
      id: "delivery", scenario, sourceRecordId: "source",
      eventSnapshot: scenario.startsWith("REPAIR") ? repairSnapshot() : taskSnapshot(),
    },
    dataSource: source(), secureUrl, unsubscribeUrl, preparedAt, timeZone: "Europe/Warsaw",
  });
}

function source(): CommunicationTemplateDataSource {
  const employees: TemplateEmployee[] = [
    { name: "Pierwszy Serwisant", phone: null, email: "pierwszy@tiemed.pl" },
    { name: "Michał Kowalski", phone: "+48 500-600-700", email: "michal@tiemed.pl" },
  ];
  return {
    async getEmployees() { return employees; },
    async getInspections() { return inspections(); },
    async getDevices() { return []; },
  };
}

function repairSnapshot() {
  return {
    businessNumber: "24346",
    clientOrderNumber: "DAM.224.0582/26.DSK.JK, PS508436",
    reportedAt: "2026-06-16T00:00:00.000Z",
    completedAt: "2026-07-23T00:00:00.000Z",
    currentStatus: "ZAKOŃCZONE",
    emmaCustomerStatus: "Naprawa zakończona",
    sourceHospitalRecordId: "recHospital",
    device: {
      airtableRecordId: "recDevice",
      name: "Aparat HFNOT",
      manufacturer: "Fisher & Paykel Healthcare",
      model: "AIRVO 3",
      serialNumber: "250939J8H",
      inventoryNumber: null,
    },
  };
}

function taskSnapshot() {
  return {
    day: "2026-08-18", department: "BLOK PORODOWY",
    sourceHospitalRecordId: "recHospital",
    performerRecordIds: ["first","second"],
    linkedInspectionRecordIds: ["bad","conditional","good","pending"],
  };
}

function inspections(): TemplateInspection[] {
  return [
    inspection("good", "SPRAWNY"), { ...inspection("pending", "Oczekiwanie na części"), inspectionResult: "SPRAWNY" },
    inspection("conditional", "WARUNKOWO DOPUSZCZONY"), inspection("bad", "NIESPRAWNY"),
  ];
}

function inspection(id: string, currentStatus: string): TemplateInspection {
  return {
    airtableRecordId: id,
    businessNumber: "25793",
    clientOrderNumber: "ADZP-381-353/25",
    currentStatus,
    inspectionResult: currentStatus,
    sourceHospitalRecordId: "recHospital",
    inspectionPerformedAt: null,
    inspectionDueDate: null,
    deviceName: "Łóżko <OIOM>",
    manufacturer: "Żółty Medical",
    model: "Przegląd · 2",
    serialNumber: "SN",
    inventoryNumber: null,
    estimatedDurationSeconds: 720,
  };
}
