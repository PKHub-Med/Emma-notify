import { describe, expect, it } from "vitest";
import {
  departmentUnitKey,
  emailList,
  parseDepartmentUnits,
  singleDepartmentUnit,
} from "./department.js";
import { SERVICE_ORDER_FIELDS, TASK_FIELDS } from "./field-ids.js";
import { mapServiceOrder } from "./mappers.js";
import { mapTask } from "./task.js";

describe("department (Oddziały) parsing", () => {
  it("keeps a quoted department name that contains commas as one department", () => {
    const value = "\"Oddział Anestezjologii, Intensywnej Terapii i Leczenia Bólu\"";
    expect(parseDepartmentUnits(value)).toEqual([
      "Oddział Anestezjologii, Intensywnej Terapii i Leczenia Bólu",
    ]);
    expect(singleDepartmentUnit(value)).toBe(
      "Oddział Anestezjologii, Intensywnej Terapii i Leczenia Bólu",
    );
  });

  it("splits several linked departments and treats them as ambiguous", () => {
    const value = "Oddział Kardiologii, \"Blok Operacyjny, sala 2\"";
    expect(parseDepartmentUnits(value)).toEqual(["Oddział Kardiologii", "Blok Operacyjny, sala 2"]);
    expect(singleDepartmentUnit(value)).toBeNull();
  });

  it("collapses duplicates, whitespace and empty values", () => {
    expect(singleDepartmentUnit(["  Oddział  Kardiologii ", "Oddział Kardiologii"])).toBe(
      "Oddział Kardiologii",
    );
    expect(singleDepartmentUnit("")).toBeNull();
    expect(singleDepartmentUnit(null)).toBeNull();
  });

  it("builds a case-insensitive comparison key", () => {
    expect(departmentUnitKey(" ODDZIAŁ  Kardiologii ")).toBe("oddział kardiologii");
    expect(departmentUnitKey("  ")).toBeNull();
    expect(departmentUnitKey(null)).toBeNull();
  });

  it("normalizes e-mail lists from text and lookup values", () => {
    expect(emailList(" A@Szpital.pl, b@szpital.pl;a@szpital.pl ")).toEqual([
      "a@szpital.pl", "b@szpital.pl",
    ]);
    expect(emailList(["X@Szpital.pl", null, "brak"])).toEqual(["x@szpital.pl"]);
    expect(emailList(undefined)).toEqual([]);
  });
});

describe("department fields in mapped records", () => {
  it("maps the Task department scope and its contacts", () => {
    const mapped = mapTask({
      id: "recTask",
      createdTime: "2026-08-11T08:00:00.000Z",
      fields: {
        [TASK_FIELDS.departmentUnit]: "\"Oddział Anestezjologii, Intensywnej Terapii\"",
        [TASK_FIELDS.departmentUnitEmail]: ["Oddzialowa@Szpital.pl"],
        [TASK_FIELDS.selectedContactEmailLookup]: ["kontakt@szpital.pl"],
        [TASK_FIELDS.technicalDepartmentEmail]: ["DT@szpital.pl"],
      },
    });
    expect(mapped).toMatchObject({
      departmentUnit: "Oddział Anestezjologii, Intensywnej Terapii",
      departmentUnitKey: "oddział anestezjologii, intensywnej terapii",
      departmentUnitEmails: ["oddzialowa@szpital.pl"],
      selectedContactEmails: ["kontakt@szpital.pl"],
      technicalDepartmentEmails: ["dt@szpital.pl"],
    });
  });

  it("keeps the repair department only in the source snapshot", () => {
    const mapped = mapServiceOrder({
      id: "recService",
      createdTime: "2026-08-11T08:00:00.000Z",
      fields: {
        [SERVICE_ORDER_FIELDS.departmentUnit]: "Oddział Kardiologii",
      },
    });
    expect(mapped.sourceSnapshot.departmentUnit).toBe("Oddział Kardiologii");
    expect(mapped.sourceSnapshot.departmentUnitKey).toBe("oddział kardiologii");
    expect(mapped).not.toHaveProperty("departmentUnit");
    expect(mapped).not.toHaveProperty("departmentUnitKey");
  });
});
