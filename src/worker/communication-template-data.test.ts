import { describe, expect, it } from "vitest";
import { CommunicationScenario } from "../generated/prisma/enums.js";
import { COMMUNICATION_TEMPLATE_ALIASES } from "./communication-template-registry.js";
import {
  buildCommunicationTemplatePayload,
  type CommunicationTemplateDataSource,
  type TemplateEmployee,
  type TemplateInspection,
} from "./communication-template-data.js";

const preparedAt = new Date("2026-08-15T10:00:00Z");
const secureUrl = "https://notify.example.org/p/signed-token";
const unsubscribeUrl = "https://notify.example.org/u/signed-token";

const repairKeys = [
  "SERVICE_NAME","SENT_AT","EMAIL_TITLE","REPAIR_COUNT","REPAIRS_ROWS",
  "CASE_NUMBER","CLIENT_ORDER_NUMBER","REPORTED_AT","COMPLETED_AT","DEVICE_NAME",
  "MANUFACTURER_MODEL","SERIAL_NUMBER","INVENTORY_NUMBER","REPAIR_STATUS",
  "DEVICE_STATUS","EMMA_SECURE_URL","EMMA_UNSUBSCRIBE_URL",
];
const expectedKeys: Record<CommunicationScenario, string[]> = {
  REPAIR_RECEIVED: repairKeys,
  REPAIR_COMPLETED: repairKeys,
  INSPECTION_DATE_CONFIRMED: ["SERVICE_NAME","SENT_AT","VISIT_DATE","DEPARTMENT","DEVICE_COUNT","DEVICES_ROWS","EMMA_SECURE_URL","EMMA_UNSUBSCRIBE_URL"],
  INSPECTION_DATE_PROPOSED: ["SERVICE_NAME","SENT_AT","VISIT_DATE","DEPARTMENT","DEVICE_COUNT","COORDINATOR_NAME","COORDINATOR_PHONE","COORDINATOR_EMAIL","COORDINATOR_REPLY_URL","DEVICES_ROWS","EMMA_SECURE_URL","EMMA_UNSUBSCRIBE_URL"],
  INSPECTION_REMINDER: ["SERVICE_NAME","SENT_AT","VISIT_DATE","DEPARTMENT","DEVICE_COUNT","TECHNICIAN_NAME","TECHNICIAN_PHONE","TECHNICIAN_PHONE_TEL","TECHNICIAN_EMAIL","DEVICES_ROWS","EMMA_SECURE_URL","EMMA_UNSUBSCRIBE_URL"],
  INSPECTION_COMPLETED: ["SERVICE_NAME","SENT_AT","VISIT_DATE","PASSED_COUNT","CONDITIONAL_COUNT","FAILED_COUNT","RESULT_ROWS","EMMA_SECURE_URL","EMMA_UNSUBSCRIBE_URL"],
};

describe("published communication template registry", () => {
  it("maps exactly the six active scenarios and excludes delayed parts", () => {
    expect(COMMUNICATION_TEMPLATE_ALIASES).toEqual({
      REPAIR_RECEIVED: "emma-repair-received", REPAIR_COMPLETED: "emma-repair-completed",
      INSPECTION_DATE_CONFIRMED: "emma-inspection-confirmed", INSPECTION_DATE_PROPOSED: "emma-inspection-proposed",
      INSPECTION_REMINDER: "emma-inspection-reminder", INSPECTION_COMPLETED: "emma-inspection-summary",
    });
    expect(Object.values(COMMUNICATION_TEMPLATE_ALIASES)).not.toContain("emma-repair-delayed-parts-phase1");
  });

  it.each(Object.values(CommunicationScenario))("uses exact variable contract for %s", async (scenario) => {
    const payload = await build(scenario);
    expect(payload.templateId).toBe(COMMUNICATION_TEMPLATE_ALIASES[scenario]);
    expect(Object.keys(payload.variables).sort()).toEqual([...expectedKeys[scenario]].sort());
    expect(Object.values(payload.variables).every((value) => value !== undefined && value !== null)).toBe(true);
    expect(payload.variables.EMMA_SECURE_URL).toBe(
      scenario === CommunicationScenario.INSPECTION_REMINDER
        ? `${secureUrl}#inspections`
        : secureUrl,
    );
    expect(payload.variables.EMMA_UNSUBSCRIBE_URL).toBe(unsubscribeUrl);
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
        delivery: { id: "delivery", scenario, sourceRecordId: "source", eventSnapshot: taskSnapshot() },
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
  it("uses inspection snapshot fields, escapes HTML and includes per-device duration", async () => {
    const variables = (await build(CommunicationScenario.INSPECTION_DATE_CONFIRMED)).variables;
    expect(variables.DEVICES_ROWS).toContain("Łóżko &lt;OIOM&gt;");
    expect(variables.DEVICES_ROWS).toContain("Producent: Żółty Medical");
    expect(variables.DEVICES_ROWS).toContain("Model: Przegląd · 2");
    expect(variables.DEVICES_ROWS).toContain("Nr zlecenia klienta: ADZP-381-353/25");
    expect(variables.DEVICES_ROWS).toContain("Numer Sprawy: 25793");
    expect(variables.DEVICES_ROWS).toContain("12 min");
    expect(variables.DEVICES_ROWS).not.toContain("Ă‚Â·");
  });

  it("sorts completed inspection results problem-first", async () => {
    const variables = (await build(CommunicationScenario.INSPECTION_COMPLETED)).variables;
    expect(variables).toMatchObject({ FAILED_COUNT: "1", CONDITIONAL_COUNT: "1", PASSED_COUNT: "1" });
    expect(variables.RESULT_ROWS!.indexOf("NIESPRAWNY")).toBeLessThan(variables.RESULT_ROWS!.indexOf("WARUNKOWO DOPUSZCZONY"));
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
    performerRecordIds: ["first","second"],
    linkedInspectionRecordIds: ["bad","conditional","good","pending"],
  };
}

function inspections(): TemplateInspection[] {
  return [
    inspection("good", "SPRAWNY"), inspection("pending", "Oczekiwanie na części"),
    inspection("conditional", "WARUNKOWO DOPUSZCZONY"), inspection("bad", "NIESPRAWNY"),
  ];
}

function inspection(id: string, currentStatus: string): TemplateInspection {
  return {
    airtableRecordId: id,
    businessNumber: "25793",
    clientOrderNumber: "ADZP-381-353/25",
    currentStatus,
    deviceName: "Łóżko <OIOM>",
    manufacturer: "Żółty Medical",
    model: "Przegląd · 2",
    serialNumber: "SN",
    inventoryNumber: null,
    estimatedDurationSeconds: 720,
  };
}
