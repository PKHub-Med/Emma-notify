import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../generated/prisma/client.js";
import { PrismaAnalyticsAdminService } from "./service.js";

describe("analytics CSV export", () => {
  it("paginates through every matching delivery without the dashboard limit", async () => {
    const delivery = (index: number) => ({
      id: `delivery-${String(index).padStart(3, "0")}`,
      sentAt: new Date("2026-10-01T10:00:00.000Z"),
      scenario: "REPAIR_RECEIVED",
      emailMode: "PRODUCTION",
      actualRecipientEmail: `recipient-${index}@example.com`,
      communicationEventRecipient: { email: null, normalizedEmail: null },
      portalAccessGrant: null,
      analyticsEvents: [],
    });
    const firstPage = Array.from({ length: 500 }, (_, index) => delivery(index));
    const secondPage = [delivery(500)];
    const findMany = vi.fn()
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(secondPage);
    const prisma = {
      communicationDelivery: { findMany },
      trackedHospital: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as PrismaClient;
    const service = new PrismaAnalyticsAdminService(prisma);
    const rows = [];

    for await (const row of service.exportRows({
      from: new Date("2026-10-01T00:00:00.000Z"),
      to: new Date("2026-10-31T23:59:59.999Z"),
      mode: "ALL",
    })) rows.push(row);

    expect(rows).toHaveLength(501);
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(findMany.mock.calls[0]?.[0]).toMatchObject({ take: 500 });
    expect(findMany.mock.calls[1]?.[0]).toMatchObject({
      take: 500,
      cursor: { id: "delivery-499" },
      skip: 1,
    });
  });
});
