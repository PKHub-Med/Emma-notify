import { describe, expect, it } from "vitest";
import { mapCaseDigestTemplate, type CaseDigestTemplateItem } from "./case-digest-template.js";

const detailUrl = "https://emma.example.org/case/access-token";

describe("CASE_DIGEST hosted template mapping", () => {
  it("shows one row and explicitly hides rows 2 through 5", () => {
    const result = map(1);
    expect(result.variables.ROW_1_DISPLAY).toBe("table-row");
    for (let slot = 2; slot <= 5; slot += 1) {
      expect(result.variables[`ROW_${slot}_DISPLAY`]).toBe("none");
      expect(result.variables[`DEVICE_${slot}_NAME`]).toBe("");
      expect(result.variables[`DEVICE_${slot}_META`]).toBe("");
      expect(result.variables[`DEVICE_${slot}_STATUS`]).toBe("");
    }
  });

  it("shows all five rows without MORE", () => {
    const result = map(5);
    for (let slot = 1; slot <= 5; slot += 1) {
      expect(result.variables[`ROW_${slot}_DISPLAY`]).toBe("table-row");
    }
    expect(result.variables.MORE_DISPLAY).toBe("none");
    expect(result.variables.MORE_TEXT).toBe("");
  });

  it("limits eight items to five and reports three more", () => {
    const result = map(8);
    expect(result.itemsShown).toBe(5);
    expect(result.variables.MORE_DISPLAY).toBe("block");
    expect(result.variables.MORE_TEXT).toBe("+ 3 kolejne aktualizacje");
  });

  it("reports seven more for twelve items", () => {
    expect(map(12).variables.MORE_TEXT).toBe("+ 7 kolejnych aktualizacji");
  });

  it("uses safe fallbacks for missing device name and optional meta", () => {
    const result = mapCaseDigestTemplate({
      mode: "TEST",
      itemsCount: 1,
      items: [{
        trackedCaseId: "case-1",
        lastEventAt: new Date("2026-08-08T15:53:00.000Z"),
        snapshot: {
          caseType: "SERVICE_ORDER",
          businessNumber: null,
          currentStatus: "Gotowe",
          device: { name: null },
        },
      }],
      detailUrl,
    });
    expect(result.variables.DEVICE_1_NAME).toBe("Urządzenie medyczne");
    expect(result.variables.DEVICE_1_META).toBe("");
    expect(Object.values(result.variables)).not.toContain("null");
    expect(Object.values(result.variables)).not.toContain("undefined");
  });

  it("sorts newest first with trackedCaseId as a stable tie-breaker", () => {
    const items = [
      templateItem(1, "case-z", "2026-08-08T14:00:00.000Z"),
      templateItem(2, "case-b", "2026-08-08T15:53:00.000Z"),
      templateItem(3, "case-a", "2026-08-08T15:53:00.000Z"),
    ];
    const result = mapCaseDigestTemplate({
      mode: "TEST",
      itemsCount: 3,
      items,
      detailUrl,
    });
    expect(result.variables.DEVICE_1_NAME).toBe("Device 3");
    expect(result.variables.DEVICE_2_NAME).toBe("Device 2");
    expect(result.variables.DEVICE_3_NAME).toBe("Device 1");
    expect(result.variables.LAST_UPDATED).toBe("08.08.2026, 17:53");
  });

  it("sets environment variables without recipient PII", () => {
    const testVariables = map(1, "TEST").variables;
    expect(testVariables.TEST_DISPLAY).toBe("table-row");
    expect(testVariables.ENVIRONMENT_LABEL).toBe("TRYB TESTOWY");
    expect(testVariables.ENVIRONMENT_NOTE).toBe(
      "Wiadomość nie została wysłana do klienta.",
    );
    expect(Object.values(testVariables).join(" ")).not.toContain("client@example.com");

    const productionVariables = map(1, "PRODUCTION").variables;
    expect(productionVariables.TEST_DISPLAY).toBe("none");
    expect(productionVariables.ENVIRONMENT_LABEL).toBe("");
    expect(productionVariables.ENVIRONMENT_NOTE).toBe("");
  });

  it("rejects a missing or placeholder detail URL", () => {
    expect(() => mapCaseDigestTemplate({
      mode: "TEST",
      itemsCount: 1,
      items: [templateItem(1)],
      detailUrl: null,
    })).toThrow("DETAIL_URL_NOT_AVAILABLE");
    expect(() => mapCaseDigestTemplate({
      mode: "TEST",
      itemsCount: 1,
      items: [templateItem(1)],
      detailUrl: "https://example.com/#",
    })).toThrow("DETAIL_URL_NOT_AVAILABLE");
  });
});

function map(itemsCount: number, mode: "TEST" | "PRODUCTION" = "TEST") {
  return mapCaseDigestTemplate({
    mode,
    itemsCount,
    items: Array.from({ length: itemsCount }, (_, index) => templateItem(index + 1)),
    detailUrl,
  });
}

function templateItem(
  number: number,
  trackedCaseId = `case-${number}`,
  lastEventAt = `2026-08-08T15:${String(number).padStart(2, "0")}:00.000Z`,
): CaseDigestTemplateItem {
  return {
    trackedCaseId,
    lastEventAt: new Date(lastEventAt),
    snapshot: {
      caseType: number % 2 === 0 ? "INSPECTION" : "SERVICE_ORDER",
      businessNumber: String(20_000 + number),
      currentStatus: `Status ${number}`,
      device: { name: `Device ${number}` },
    },
  };
}
