import { describe, expect, it } from "vitest";
import { CommunicationScenario } from "../generated/prisma/enums.js";
import { COMMUNICATION_TEMPLATE_ALIASES } from "./communication-template-registry.js";
import { buildCommunicationTemplatePayload, type CommunicationTemplateDataSource, type TemplateEmployee, type TemplateInspection } from "./communication-template-data.js";

const preparedAt = new Date("2026-08-15T10:00:00Z");
const secureUrl = "https://notify.example.org/p/signed-token";
const unsubscribeUrl = "https://notify.example.org/u/signed-token";

const expectedKeys: Record<CommunicationScenario, string[]> = {
  REPAIR_RECEIVED: ["SERVICE_NAME","SENT_AT","CASE_NUMBER","CLIENT_ORDER_NUMBER","REPORTED_AT","DEVICE_NAME","MANUFACTURER_MODEL","SERIAL_NUMBER","INVENTORY_NUMBER","EMMA_SECURE_URL","EMMA_UNSUBSCRIBE_URL"],
  REPAIR_COMPLETED: ["SERVICE_NAME","SENT_AT","CASE_NUMBER","CLIENT_ORDER_NUMBER","DEVICE_NAME","MANUFACTURER_MODEL","SERIAL_NUMBER","INVENTORY_NUMBER","COMPLETED_AT","EMMA_SECURE_URL","EMMA_UNSUBSCRIBE_URL"],
  INSPECTION_DATE_CONFIRMED: ["SERVICE_NAME","SENT_AT","VISIT_DATE","DEPARTMENT","DEVICE_COUNT","DEVICES_ROWS","EMMA_SECURE_URL","EMMA_UNSUBSCRIBE_URL"],
  INSPECTION_DATE_PROPOSED: ["SERVICE_NAME","SENT_AT","VISIT_DATE","DEPARTMENT","DEVICE_COUNT","COORDINATOR_NAME","COORDINATOR_PHONE","COORDINATOR_EMAIL","COORDINATOR_REPLY_URL","DEVICES_ROWS","EMMA_SECURE_URL","EMMA_UNSUBSCRIBE_URL"],
  INSPECTION_REMINDER: ["SERVICE_NAME","SENT_AT","VISIT_DATE","DEPARTMENT","DEVICE_COUNT","TECHNICIAN_NAME","TECHNICIAN_PHONE","TECHNICIAN_PHONE_TEL","DEVICES_ROWS","EMMA_SECURE_URL","EMMA_UNSUBSCRIBE_URL"],
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
    expect(payload.variables.EMMA_SECURE_URL).toBe(secureUrl);
    expect(payload.variables.EMMA_UNSUBSCRIBE_URL).toBe(unsubscribeUrl);
  });
});

describe("dynamic HTML and Unicode", () => {
  it("escapes DEVICES_ROWS while preserving Polish Unicode and U+00B7", async () => {
    const variables = (await build(CommunicationScenario.INSPECTION_DATE_CONFIRMED)).variables;
    expect(variables.DEVICES_ROWS).toContain("Łóżko &lt;OIOM&gt; · Żółty Medical · Przegląd · 2");
    expect(variables.DEVICES_ROWS).not.toContain("Ă‚Â·");
  });

  it("sorts RESULT_ROWS problem-first, counts results, escapes HTML and omits INSPECTION_SUMMARY", async () => {
    const variables = (await build(CommunicationScenario.INSPECTION_COMPLETED)).variables;
    expect(variables).toMatchObject({ FAILED_COUNT: "1", CONDITIONAL_COUNT: "1", PASSED_COUNT: "1" });
    expect(variables).not.toHaveProperty("INSPECTION_SUMMARY");
    expect(variables.RESULT_ROWS!.indexOf("NIESPRAWNY")).toBeLessThan(variables.RESULT_ROWS!.indexOf("WARUNKOWO DOPUSZCZONY"));
    expect(variables.RESULT_ROWS).toContain("&lt;OIOM&gt;");
    expect(variables.RESULT_ROWS).not.toContain("Ă‚Â·");
  });

  it("selects the first valid technician phone and builds a sanitized tel URL", async () => {
    const variables = (await build(CommunicationScenario.INSPECTION_REMINDER)).variables;
    expect(variables).toMatchObject({ TECHNICIAN_NAME: "Michał Kowalski", TECHNICIAN_PHONE: "+48 500-600-700", TECHNICIAN_PHONE_TEL: "tel:+48500600700" });
  });

  it("uses fixed coordinator email and a correctly encoded Polish mailto subject", async () => {
    const variables = (await build(CommunicationScenario.INSPECTION_DATE_PROPOSED)).variables;
    expect(variables.COORDINATOR_EMAIL).toBe("serwis@tiemed.pl");
    expect(decodeURIComponent(variables.COORDINATOR_REPLY_URL!)).toContain("Odpowiedź dotycząca terminu wizyty");
  });
});

async function build(scenario: CommunicationScenario) {
  return buildCommunicationTemplatePayload({
    delivery: { id: "delivery", scenario, sourceRecordId: "source", eventSnapshot: scenario.startsWith("REPAIR") ? repairSnapshot() : taskSnapshot() },
    dataSource: source(), secureUrl, unsubscribeUrl, preparedAt, timeZone: "Europe/Warsaw",
  });
}
function source(): CommunicationTemplateDataSource {
  const employees: TemplateEmployee[] = [{ name: "Bez telefonu", phone: "x" }, { name: "Michał Kowalski", phone: "+48 500-600-700" }];
  return { async getEmployees() { return employees; }, async getInspections() { return inspections(); } };
}
function repairSnapshot() { return { businessNumber: "SO-12", clientOrderNumber: "Nr zlecenia klienta", sourceCreatedAt: "2026-08-10T10:00:00Z", detectedAt: "2026-08-15T10:00:00Z", device: { name: "Urządzenie", manufacturer: "Damian · Tiemed", model: "Przegląd", serialNumber: "Łódź", inventoryNumber: "Żółty" } }; }
function taskSnapshot() { return { day: "2026-08-15", department: "Łódź", performerRecordIds: ["a","b"], linkedInspectionRecordIds: ["bad","conditional","good","pending"] }; }
function inspections(): TemplateInspection[] { return [
  inspection("good", "SPRAWNY"), inspection("pending", "Oczekiwanie na części"),
  inspection("conditional", "WARUNKOWO DOPUSZCZONY"), inspection("bad", "NIESPRAWNY"),
]; }
function inspection(id: string, currentStatus: string): TemplateInspection { return { airtableRecordId: id, currentStatus, deviceName: "Łóżko <OIOM>", manufacturer: "Żółty Medical", model: "Przegląd · 2", serialNumber: "SN", inventoryNumber: null }; }
