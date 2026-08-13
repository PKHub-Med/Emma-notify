import { describe, expect, it } from "vitest";
import { parseInspectionDueDate } from "./parse-inspection-due-date.js";

describe("parseInspectionDueDate", () => {
  it.each([
    ["13-08-2026", "2026-08-13T00:00:00.000Z"],
    ["31-07-2027", "2027-07-31T00:00:00.000Z"],
    ["2027-08-07", "2027-08-07T00:00:00.000Z"],
    ["29.02.2024", "2024-02-29T00:00:00.000Z"],
  ])("parses %s", (input, expected) => {
    expect(parseInspectionDueDate(input)?.toISOString()).toBe(expected);
  });

  it.each(["#ERROR!", "", "invalid", "31-02-2027", "31.02.2026", "29.02.2025"])(
    "returns null for %s",
    (input) => {
      expect(parseInspectionDueDate(input)).toBeNull();
    },
  );
});
