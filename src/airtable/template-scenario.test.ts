import { describe, expect, it } from "vitest";
import {
  EMMA_MAIL_SCENARIOS,
  mapEmmaMailTemplate,
} from "./template-scenario.js";

describe("EMMA mail template mapping", () => {
  it.each([
    ["Naprawa-zmiana_stanu", EMMA_MAIL_SCENARIOS.REPAIR_STATUS_CHANGE],
    [
      "Przegląd-informacja_o_nadchodzącej_wizycie",
      EMMA_MAIL_SCENARIOS.INSPECTION_DATE_PROPOSED,
    ],
    [
      "Przegląd-informacja_o_umówionej_wizycie",
      EMMA_MAIL_SCENARIOS.INSPECTION_DATE_CONFIRMED,
    ],
    [
      "Przegląd-przypomnienie_o_wizycie",
      EMMA_MAIL_SCENARIOS.INSPECTION_REMINDER,
    ],
    [
      "Przegląd-podsumowanie_wizyty",
      EMMA_MAIL_SCENARIOS.INSPECTION_COMPLETED,
    ],
  ])("maps %s to %s", (template, scenario) => {
    expect(mapEmmaMailTemplate(template)).toBe(scenario);
  });

  it.each(["", "Nieznany-template", null, undefined])(
    "returns no mapping for unsupported value %s",
    (template) => {
      expect(mapEmmaMailTemplate(template)).toBeNull();
    },
  );

  it("does not fall back to a default scenario", () => {
    expect(mapEmmaMailTemplate("Naprawa-inny_template")).toBeNull();
  });
});
