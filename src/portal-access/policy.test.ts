import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../generated/prisma/client.js";
import { PortalAccessLevel } from "../generated/prisma/enums.js";
import {
  DEFAULT_PORTAL_ACCESS_LEVEL,
  PrismaPortalAccessPolicy,
  visibleCaseSql,
  visibleDeviceSql,
} from "./policy.js";

describe("PortalAccessPolicy", () => {
  it("fails closed to COMMUNICATION when a Hospital has no entitlement", async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const policy = new PrismaPortalAccessPolicy({
      hospitalPortalEntitlement: { findUnique },
    } as unknown as PrismaClient);

    await expect(policy.resolve("hospital-A")).resolves.toEqual({
      hospitalId: "hospital-A",
      accessLevel: PortalAccessLevel.COMMUNICATION,
    });
    expect(DEFAULT_PORTAL_ACCESS_LEVEL).toBe(PortalAccessLevel.COMMUNICATION);
  });

  it("resolves an explicit FULL entitlement without changing the grant/token", async () => {
    const policy = new PrismaPortalAccessPolicy({
      hospitalPortalEntitlement: {
        findUnique: vi.fn().mockResolvedValue({ accessLevel: PortalAccessLevel.FULL }),
      },
    } as unknown as PrismaClient);
    await expect(policy.resolve("hospital-A")).resolves.toEqual({
      hospitalId: "hospital-A", accessLevel: PortalAccessLevel.FULL,
    });
  });

  it("classifies communication by SENT logical CLIENT recipient, never physical TEST email", () => {
    const sql = visibleCaseSql({
      hospitalId: "hospital-A", accessLevel: PortalAccessLevel.COMMUNICATION,
    }, "SERVICE_ORDER").strings.join("?");
    expect(sql).toContain("communication_delivery.status = 'SENT'");
    expect(sql).toContain('communication_recipient."recipientType" = \'CLIENT\'');
    expect(sql).not.toContain("actualRecipientEmail");
    expect(sql).not.toContain("emailMode");
    expect(sql).not.toContain("TIEMED_FALLBACK");
  });

  it("derives COMMUNICATION Devices only through visible Cases", () => {
    const sql = visibleDeviceSql({
      hospitalId: "hospital-A", accessLevel: PortalAccessLevel.COMMUNICATION,
    }).strings.join("?");
    expect(sql).toContain('FROM "TrackedCaseDevice"');
    expect(sql).toContain('c."sourceHospitalRecordId" =');
    expect(sql).toContain("'SENT'");
    expect(sql).toContain("'CLIENT'");
  });

  it("keeps FULL predicates hospital-scoped by returning no access restriction fragment", () => {
    const access = { hospitalId: "hospital-A", accessLevel: PortalAccessLevel.FULL };
    expect(visibleCaseSql(access, "SERVICE_ORDER").strings.join("")).toBe("");
    expect(visibleDeviceSql(access).strings.join("")).toBe("");
  });
});
