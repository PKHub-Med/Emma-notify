import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "../generated/prisma/client.js";
import { EventType } from "../generated/prisma/enums.js";
import { SERVICE_ORDER_FIELDS } from "../airtable/field-ids.js";
import { mapServiceOrder } from "../airtable/mappers.js";
import type { AirtableRecord } from "../airtable/types.js";
import { PrismaBaselineStore } from "./baseline-store.js";
import { PrismaIncrementalStore } from "./incremental-store.js";

describe("TrackedCase completedAt persistence", () => {
  it("keeps repair productionYear in sourceSnapshot and out of Prisma upsert payloads", async () => {
    const upsert = vi.fn(async (_args: Prisma.TrackedCaseUpsertArgs) => ({ id: "case-1" }));
    const transaction = {
      trackedCase: { upsert },
      trackedCaseDevice: {
        deleteMany: vi.fn(async () => ({ count: 0 })),
        createMany: vi.fn(async () => ({ count: 0 })),
      },
    } as unknown as Prisma.TransactionClient;
    const mapped = serviceOrder("2026-09-11T15:30:00.000Z", undefined, [2021]);

    expect(mapped.sourceSnapshot.productionYear).toBe("2021");
    expect(mapped).not.toHaveProperty("productionYear");
    await new PrismaBaselineStore(transaction).upsertCase(
      mapped,
      new Date("2026-09-12T08:00:00.000Z"),
    );

    const payload = upsert.mock.calls[0]?.[0];
    expect(payload?.create).not.toHaveProperty("productionYear");
    expect(payload?.update).not.toHaveProperty("productionYear");
    expect(payload?.create).toMatchObject({
      sourceSnapshot: expect.objectContaining({ productionYear: "2021" }),
    });
  });

  it("includes completedAt in baseline create and update payloads", async () => {
    const upsert = vi.fn(async () => ({ id: "case-1" }));
    const transaction = {
      trackedCase: { upsert },
      trackedCaseDevice: {
        deleteMany: vi.fn(async () => ({ count: 0 })),
        createMany: vi.fn(async () => ({ count: 0 })),
      },
    } as unknown as Prisma.TransactionClient;
    const completedAt = new Date("2026-09-11T15:30:00.000Z");

    await new PrismaBaselineStore(transaction).upsertCase(
      serviceOrder(completedAt.toISOString()),
      new Date("2026-09-12T08:00:00.000Z"),
    );

    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ completedAt }),
      update: expect.objectContaining({ completedAt }),
    }));
  });

  it("persists explicit repair detail columns in baseline payloads", async () => {
    const upsert = vi.fn(async () => ({ id: "case-1" }));
    const transaction = {
      trackedCase: { upsert },
      trackedCaseDevice: {
        deleteMany: vi.fn(async () => ({ count: 0 })),
        createMany: vi.fn(async () => ({ count: 0 })),
      },
    } as unknown as Prisma.TransactionClient;

    await new PrismaBaselineStore(transaction).upsertCase(
      serviceOrder("2026-09-11T15:30:00.000Z"),
      new Date("2026-09-12T08:00:00.000Z"),
    );

    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        repairHeroLabel: "DIAGNOSTYKA",
        repairHeroDescription: "Opis hero",
        repairReporter: "Klinika",
        repairValidation: "OK",
        repairOfferNumber: "OF/12",
        repairDescription: "Opis naprawy",
      }),
      update: expect.objectContaining({ repairOfferNumber: "OF/12" }),
    }));
  });

  it("includes completedAt in an incremental status-change update payload", async () => {
    const completedAt = new Date("2026-09-11T15:30:00.000Z");
    const update = vi.fn(async () => ({ id: "case-1" }));
    const transaction = {
      trackedCase: {
        findUniqueOrThrow: vi.fn(async () => ({ currentStatus: "Przyjęte" })),
        update,
      },
      caseEvent: { create: vi.fn(async () => ({ id: "event-1" })) },
      trackedCaseDevice: {
        deleteMany: vi.fn(async () => ({ count: 0 })),
        createMany: vi.fn(async () => ({ count: 0 })),
      },
      caseRecipient: { findMany: vi.fn(async () => []) },
    };
    const prisma = {
      $transaction: vi.fn(async (operation: (tx: typeof transaction) => Promise<unknown>) =>
        operation(transaction)),
    };

    await new PrismaIncrementalStore(prisma as never).processStatusChange({
      trackedCaseId: "case-1",
      mappedCase: serviceOrder(completedAt.toISOString(), "Zakończone"),
      eventType: EventType.SERVICE_STATUS_CHANGED,
      oldStatus: "Przyjęte",
      newStatus: "Zakończone",
      fingerprint: "fingerprint-1",
      detectedAt: new Date("2026-09-12T08:00:00.000Z"),
      quietMinutes: 5,
    });

    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ completedAt }),
    }));
  });
});

function serviceOrder(completedAt: string, status?: string, productionYear?: unknown) {
  const record: AirtableRecord = {
    id: "recService",
    createdTime: "2026-09-01T08:00:00.000Z",
    fields: {
      [SERVICE_ORDER_FIELDS.completedAt]: completedAt,
      [SERVICE_ORDER_FIELDS.repairHeroLabel]: "DIAGNOSTYKA",
      [SERVICE_ORDER_FIELDS.repairHeroDescription]: "Opis hero",
      [SERVICE_ORDER_FIELDS.repairReporter]: "Klinika",
      [SERVICE_ORDER_FIELDS.repairValidation]: "OK",
      [SERVICE_ORDER_FIELDS.repairOfferNumber]: "OF/12",
      [SERVICE_ORDER_FIELDS.repairDescription]: "Opis naprawy",
      ...(productionYear === undefined
        ? {}
        : { [SERVICE_ORDER_FIELDS.productionYear]: productionYear }),
      ...(status ? { [SERVICE_ORDER_FIELDS.customerStatus]: status } : {}),
    },
  };
  return mapServiceOrder(record);
}
