import { describe, expect, it } from "vitest";
import type { PrismaClient } from "../generated/prisma/client.js";
import { PortalAccessLevel } from "../generated/prisma/enums.js";
import {
  departmentCaseSql,
  resolvePortalDepartmentScope,
  visibleCaseSql,
  visibleDeviceSql,
} from "./policy.js";

const TASK_SNAPSHOT = {
  departmentUnit: "Oddział Kardiologii",
  departmentUnitKey: "oddział kardiologii",
  departmentUnitEmails: ["oddzialowa@szpital.pl"],
  selectedContactEmails: ["kontakt@szpital.pl"],
  technicalDepartmentEmails: ["dt@szpital.pl"],
};

function prisma(options: {
  sourceEntityType?: string;
  recipientType?: string;
  email: string;
  hospital?: string;
  snapshot?: Record<string, unknown>;
}) {
  return {
    communicationDelivery: {
      findUnique: async () => ({
        communicationEvent: {
          sourceEntityType: options.sourceEntityType ?? "TASK",
          sourceRecordId: "recTask",
        },
        communicationEventRecipient: {
          recipientType: options.recipientType ?? "CLIENT",
          normalizedEmail: options.email,
          email: options.email,
        },
      }),
    },
    trackedTask: {
      findUnique: async () => ({
        sourceHospitalRecordId: options.hospital ?? "H1",
        sourceSnapshot: options.snapshot ?? TASK_SNAPSHOT,
      }),
    },
  } as unknown as PrismaClient;
}

describe("portal department scope", () => {
  it("limits a link sent to the department nurse to that department", async () => {
    await expect(resolvePortalDepartmentScope(
      prisma({ email: "oddzialowa@szpital.pl" }), "delivery-1", "H1",
    )).resolves.toEqual({ key: "oddział kardiologii", name: "Oddział Kardiologii" });
  });

  it("limits a link sent to the selected department contact", async () => {
    await expect(resolvePortalDepartmentScope(
      prisma({ email: "kontakt@szpital.pl" }), "delivery-1", "H1",
    )).resolves.toEqual({ key: "oddział kardiologii", name: "Oddział Kardiologii" });
  });

  it("keeps the whole hospital for the technical department", async () => {
    await expect(resolvePortalDepartmentScope(
      prisma({ email: "dt@szpital.pl" }), "delivery-1", "H1",
    )).resolves.toBeNull();
    await expect(resolvePortalDepartmentScope(prisma({
      email: "oddzialowa@szpital.pl",
      snapshot: { ...TASK_SNAPSHOT, technicalDepartmentEmails: ["oddzialowa@szpital.pl"] },
    }), "delivery-1", "H1")).resolves.toBeNull();
  });

  it("keeps the whole hospital for repairs, Tiemed fallbacks, other hospitals and unknown departments", async () => {
    for (const client of [
      prisma({ email: "oddzialowa@szpital.pl", sourceEntityType: "SERVICE_ORDER" }),
      prisma({ email: "oddzialowa@szpital.pl", recipientType: "TIEMED_FALLBACK" }),
      prisma({ email: "oddzialowa@szpital.pl", hospital: "H2" }),
      prisma({ email: "oddzialowa@szpital.pl", snapshot: { ...TASK_SNAPSHOT, departmentUnitKey: null } }),
      prisma({ email: "ktos@szpital.pl" }),
    ]) {
      await expect(resolvePortalDepartmentScope(client, "delivery-1", "H1")).resolves.toBeNull();
    }
  });

  it("fails open to the hospital-wide view when delegates are missing", async () => {
    await expect(resolvePortalDepartmentScope(
      {} as unknown as PrismaClient, "delivery-1", "H1",
    )).resolves.toBeNull();
  });

  it("adds department predicates only when a department key is set", () => {
    const hospital = { hospitalId: "H1", accessLevel: PortalAccessLevel.FULL };
    expect(departmentCaseSql(hospital, "SERVICE_ORDER").strings.join("")).toBe("");
    expect(visibleCaseSql(hospital, "INSPECTION").strings.join("")).toBe("");
    expect(visibleDeviceSql(hospital).strings.join("")).toBe("");

    const department = { ...hospital, departmentKey: "oddział kardiologii" };
    const repair = visibleCaseSql(department, "SERVICE_ORDER");
    expect(repair.strings.join("?")).toContain("'departmentUnitKey' = ?");
    expect(repair.values).toContain("oddział kardiologii");
    const inspection = visibleCaseSql(department, "INSPECTION");
    expect(inspection.strings.join("?")).toContain("\"linkedInspectionRecordIds\" ? c.\"airtableRecordId\"");
    expect(inspection.values).toEqual(expect.arrayContaining(["H1", "oddział kardiologii"]));
    expect(visibleDeviceSql(department).strings.join("")).not.toBe("");
  });

  it("combines the department with COMMUNICATION grants", () => {
    const sql = visibleCaseSql({
      hospitalId: "H1",
      accessLevel: PortalAccessLevel.COMMUNICATION,
      communicationDeliveryId: "delivery-1",
      departmentKey: "oddział kardiologii",
    }, "SERVICE_ORDER");
    expect(sql.values).toEqual(expect.arrayContaining(["delivery-1", "oddział kardiologii"]));
  });
});
