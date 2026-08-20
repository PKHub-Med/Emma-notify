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

  it("unlocks a Repair only from its canonical direct SERVICE_ORDER event", () => {
    const sql = visibleCaseSql({
      hospitalId: "hospital-A", accessLevel: PortalAccessLevel.COMMUNICATION,
    }, "SERVICE_ORDER").strings.join("?");
    expect(sql).toContain('communication_event."sourceEntityType" = \'SERVICE_ORDER\'');
    expect(sql).toContain('communication_event."sourceRecordId" = c."airtableRecordId"');
    expect(sql).not.toContain("linkedServiceOrderRecordIds");
    expect(sql).not.toContain("'TASK'");
  });

  it("unlocks a repair batch only through SENT deliveries sharing the grant message", () => {
    const fragment = visibleCaseSql({
      hospitalId: "hospital-A", accessLevel: PortalAccessLevel.COMMUNICATION,
      communicationDeliveryId: "delivery-fallback-R1",
    }, "SERVICE_ORDER");
    const sql = fragment.strings.join("?");
    expect(sql).toContain('FROM "CommunicationDelivery" grant_delivery');
    expect(sql).toContain('JOIN "CommunicationDelivery" batch_delivery');
    expect(sql).toContain('batch_delivery."resendMessageId" = grant_delivery."resendMessageId"');
    expect(sql).toContain("grant_delivery.id =");
    expect(sql).toContain("grant_delivery.status = 'SENT'");
    expect(sql).toContain("batch_delivery.status = 'SENT'");
    expect(sql).toContain('grant_delivery."resendMessageId" IS NOT NULL');
    expect(fragment.values).toContain("delivery-fallback-R1");
    const grantBranch = sql.slice(sql.indexOf('FROM "CommunicationDelivery" grant_delivery'));
    expect(grantBranch).not.toContain('communication_recipient."recipientType"');
    expect(sql).not.toContain("linkedServiceOrderRecordIds");
  });

  it("unlocks only linked Inspections for the four canonical TASK inspection scenarios", () => {
    const sql = visibleCaseSql({
      hospitalId: "hospital-A", accessLevel: PortalAccessLevel.COMMUNICATION,
    }, "INSPECTION").strings.join("?");
    expect(sql).toContain('communication_event."sourceEntityType" = \'TASK\'');
    expect(sql).toContain("'INSPECTION_DATE_PROPOSED'");
    expect(sql).toContain("'INSPECTION_DATE_CONFIRMED'");
    expect(sql).toContain("'INSPECTION_REMINDER'");
    expect(sql).toContain("'INSPECTION_COMPLETED'");
    expect(sql).toContain("linkedInspectionRecordIds");
    expect(sql).not.toContain("linkedServiceOrderRecordIds");
  });

  it("keeps a fallback inspection TASK grant limited to linkedInspectionRecordIds", () => {
    const fragment = visibleCaseSql({
      hospitalId: "hospital-A", accessLevel: PortalAccessLevel.COMMUNICATION,
      communicationDeliveryId: "delivery-fallback-task",
    }, "INSPECTION");
    const sql = fragment.strings.join("?");
    expect(fragment.values).toContain("delivery-fallback-task");
    expect(sql).toContain("linkedInspectionRecordIds");
    expect(sql).not.toContain("linkedServiceOrderRecordIds");
  });

  it("derives COMMUNICATION Devices only through visible Cases", () => {
    const sql = visibleDeviceSql({
      hospitalId: "hospital-A", accessLevel: PortalAccessLevel.COMMUNICATION,
    }).strings.join("?");
    expect(sql).toContain('FROM "TrackedCaseDevice"');
    expect(sql).toContain('c."sourceHospitalRecordId" =');
    expect(sql).toContain("'SENT'");
    expect(sql).toContain("'CLIENT'");
    expect(sql).not.toContain("linkedServiceOrderRecordIds");
  });

  it("keeps FULL predicates hospital-scoped by returning no access restriction fragment", () => {
    const access = { hospitalId: "hospital-A", accessLevel: PortalAccessLevel.FULL };
    expect(visibleCaseSql(access, "SERVICE_ORDER").strings.join("")).toBe("");
    expect(visibleDeviceSql(access).strings.join("")).toBe("");
  });
});
