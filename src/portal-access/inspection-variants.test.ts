import { describe, expect, it } from "vitest";
import {
  inspectionDesignVariant,
  inspectionPortalStatus,
  inspectionVerificationFailureReason,
  isInspectionVerified,
  polishPhotoCountLabel,
} from "./view-model.js";

describe("inspection V5 presentation variants", () => {
  it.each([
    ["DO REALIZACJI", null, true, "DUE"],
    ["W TRAKCIE REALIZACJI", null, true, "SCHEDULED"],
    ["WYKONANY", "SPRAWNY", true, "PASSED"],
    ["WYKONANY", "WARUNKOWO DOPUSZCZONY", true, "CONDITIONAL"],
    ["WYKONANY", "NIESPRAWNY", true, "FAILED"],
    ["PROBLEM", null, true, "PROBLEM"],
    ["ZAKOŃCZONY", "SPRAWNY", true, "PASSED"],
    ["ZAKOŃCZONY", "WARUNKOWO DOPUSZCZONY", true, "CONDITIONAL"],
    ["ZAKOŃCZONY", "NIESPRAWNY", true, "FAILED"],
    ["DO WERYFIKACJI", "SPRAWNY", false, "VERIFY"],
    ["WYKONANY", "SPRAWNY", false, "VERIFY"],
  ])("maps %s / %s without deriving a business status", (status, result, verified, expected) => {
    expect(inspectionDesignVariant(status, result, verified)).toBe(expected);
  });
});

describe("inspection photo count", () => {
  it.each([
    [0, "Zdjęcia"], [1, "1 zdjęcie"], [2, "2 zdjęcia"], [4, "4 zdjęcia"],
    [5, "5 zdjęć"], [12, "12 zdjęć"], [22, "22 zdjęcia"],
  ])("formats %i", (count, expected) => {
    expect(polishPhotoCountLabel(count)).toBe(expected);
  });
});

describe("inspection customer-facing status", () => {
  it.each([
    ["WYKONANY", "OK", null],
    [null, "OK", "MISSING_CURRENT_STATUS"],
    ["DO WERYFIKACJI", "OK", "CURRENT_STATUS_REQUIRES_VERIFICATION"],
    ["WYKONANY", null, "MISSING_VALIDATION"],
    ["WYKONANY", "BŁĄD: brak wyniku", "VALIDATION_NOT_OK"],
  ] as const)(
    "validates status=%j validation=%j with reason %j",
    (status, validation, reason) => {
      expect(inspectionVerificationFailureReason(status, validation)).toBe(reason);
      expect(isInspectionVerified(status, validation)).toBe(reason === null);
    },
  );

  it.each(["ZF", "Zafakturowano", "UMÓWIONE"])(
    "uses the neutral verification state instead of administrative status %s",
    (adminStatus) => {
      const customerStatus = inspectionPortalStatus(null, "OK");

      expect(customerStatus).toBe("Dane wymagają weryfikacji");
      expect(customerStatus).not.toBe(adminStatus);
    },
  );
});
