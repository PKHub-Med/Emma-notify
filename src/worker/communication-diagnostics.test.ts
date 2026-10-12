import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../generated/prisma/client.js";
import {
  CommunicationDiagnosticOrigin,
  CommunicationDiagnosticStatus,
  CommunicationScenario,
  CommunicationSourceEntityType,
} from "../generated/prisma/enums.js";
import { PrismaCommunicationDiagnosticRegistry } from "./communication-diagnostics.js";
import type { CommunicationObservation } from "./communication-event.js";

describe("communication diagnostic registry", () => {
  it("keeps append-only transitions and suppresses duplicate polling logs", async () => {
    const fixture = registryFixture();
    const pending = {
      sourceEntityType: CommunicationSourceEntityType.TASK,
      sourceRecordId: "recTask",
      businessNumber: "21310",
      scenario: CommunicationScenario.INSPECTION_COMPLETED,
      status: CommunicationDiagnosticStatus.PENDING_DATA,
      reasonCode: "INSPECTION_RESULTS_INCOMPLETE",
      reasonOrigin: CommunicationDiagnosticOrigin.SYNC,
      missingData: { missingResultInspectionIds: ["recInspection"] },
      checkedAt: new Date("2026-10-12T08:00:00Z"),
      nextCheckAt: new Date("2026-10-12T08:02:00Z"),
      expiresAt: new Date("2026-10-12T09:00:00Z"),
    } as const;

    expect(await fixture.registry.record(pending)).toBe(true);
    expect(await fixture.registry.record({
      ...pending,
      checkedAt: new Date("2026-10-12T08:02:00Z"),
      nextCheckAt: new Date("2026-10-12T08:04:00Z"),
      expiresAt: new Date("2026-10-12T09:02:00Z"),
    })).toBe(false);
    expect(fixture.histories).toHaveLength(1);
    expect(fixture.log).toHaveBeenCalledTimes(1);
    expect(fixture.current?.attemptCount).toBe(2);
    expect(fixture.current?.expiresAt).toEqual(new Date("2026-10-12T09:00:00Z"));

    await fixture.registry.record({
      ...pending,
      status: CommunicationDiagnosticStatus.READY,
      reasonCode: "EVENT_CREATED",
      reasonOrigin: CommunicationDiagnosticOrigin.APPLICATION,
      checkedAt: new Date("2026-10-12T08:03:00Z"),
      nextCheckAt: null,
      eventId: "event-1",
    });
    await fixture.registry.record({
      ...pending,
      status: CommunicationDiagnosticStatus.SENT,
      reasonCode: "SENT",
      reasonOrigin: CommunicationDiagnosticOrigin.PROVIDER,
      checkedAt: new Date("2026-10-12T08:04:00Z"),
      nextCheckAt: null,
      eventId: "event-1",
      deliveryId: "delivery-1",
    });

    expect(fixture.histories.map((item) => item.status)).toEqual([
      CommunicationDiagnosticStatus.PENDING_DATA,
      CommunicationDiagnosticStatus.READY,
      CommunicationDiagnosticStatus.SENT,
    ]);
    expect(fixture.log.mock.calls.flat().join(" ")).not.toContain("@");
  });

  it("prunes expired history and terminal current rows without deleting transient work", async () => {
    const historyDelete = vi.fn(async () => ({ count: 4 }));
    const currentDelete = vi.fn(async () => ({ count: 2 }));
    const prisma = {
      communicationDiagnosticHistory: { deleteMany: historyDelete },
      communicationDiagnostic: { deleteMany: currentDelete },
      $transaction: async (operation: (transaction: unknown) => unknown) => operation({
        communicationDiagnosticHistory: { deleteMany: historyDelete },
        communicationDiagnostic: { deleteMany: currentDelete },
      }),
    } as unknown as PrismaClient;
    const registry = new PrismaCommunicationDiagnosticRegistry(prisma, vi.fn());
    const now = new Date("2026-10-12T08:00:00Z");

    await expect(registry.pruneExpired(now)).resolves.toEqual({ current: 2, history: 4 });
    expect(historyDelete).toHaveBeenCalledWith({
      where: { retentionUntil: { lt: now } },
    });
    expect(currentDelete).toHaveBeenCalledOnce();
    const where = currentDelete.mock.calls[0]?.[0]?.where;
    expect(where.retentionUntil).toEqual({ lt: now });
    expect(where.status.in).not.toContain(CommunicationDiagnosticStatus.PENDING_DATA);
    expect(where.status.in).not.toContain(CommunicationDiagnosticStatus.READY);
    expect(where.status.in).not.toContain(CommunicationDiagnosticStatus.SCHEDULED);
    expect(where.status.in).toEqual(expect.arrayContaining([
      CommunicationDiagnosticStatus.NOT_ELIGIBLE,
      CommunicationDiagnosticStatus.BLOCKED,
      CommunicationDiagnosticStatus.SENT,
      CommunicationDiagnosticStatus.FAILED,
      CommunicationDiagnosticStatus.CANCELLED,
    ]));
  });

  it.each(["READY_BUT_HISTORICAL", "PENDING_DATA_EXPIRED"])(
    "keeps terminal historical block %s sticky across later polling",
    async (reasonCode) => {
      const fixture = registryFixture();
      const blockedAt = new Date("2026-10-13T00:10:00Z");
      const common = {
        sourceEntityType: CommunicationSourceEntityType.TASK,
        sourceRecordId: "recLateTask",
        businessNumber: "late-task",
        scenario: CommunicationScenario.INSPECTION_COMPLETED,
        reasonOrigin: CommunicationDiagnosticOrigin.APPLICATION,
      } as const;

      await fixture.registry.record({
        ...common,
        status: CommunicationDiagnosticStatus.BLOCKED,
        reasonCode,
        missingData: { missingResultInspectionIds: ["recInspection"] },
        checkedAt: blockedAt,
      });
      await fixture.registry.record({
        ...common,
        status: CommunicationDiagnosticStatus.READY,
        reasonCode: "EVENT_CREATED",
        checkedAt: new Date("2026-10-13T00:20:00Z"),
        eventId: "event-must-not-be-adopted",
      });

      expect(fixture.current?.status).toBe(CommunicationDiagnosticStatus.BLOCKED);
      expect(fixture.current?.reasonCode).toBe(reasonCode);
      expect(fixture.current?.missingData).toEqual({
        missingResultInspectionIds: ["recInspection"],
      });
      expect(fixture.current?.communicationEventId).toBeNull();
      expect(fixture.current?.lastCheckedAt).toEqual(new Date("2026-10-13T00:20:00Z"));
      expect(fixture.histories).toHaveLength(1);
      expect(fixture.log).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps completed data pending when the hospital scope is missing", async () => {
    const findMany = vi.fn(async () => []);
    const prisma = { trackedCase: { findMany } } as unknown as PrismaClient;
    const registry = new PrismaCommunicationDiagnosticRegistry(prisma, vi.fn());

    await expect(registry.assessCompletedData(completedObservation(
      completedSnapshot({ sourceHospitalRecordId: null }),
    ))).resolves.toMatchObject({
      ready: false,
      reasonCode: "HOSPITAL_SCOPE_MISSING",
    });
    expect(findMany).not.toHaveBeenCalled();
  });

  it("keeps completed data pending when an inspection result is not recognized", async () => {
    const prisma = {
      trackedCase: {
        findMany: vi.fn(async () => [{
          airtableRecordId: "recInspection",
          sourceHospitalRecordId: "recHospital",
          inspectionResult: null,
        }]),
      },
    } as unknown as PrismaClient;
    const registry = new PrismaCommunicationDiagnosticRegistry(prisma, vi.fn());

    await expect(registry.assessCompletedData(
      completedObservation(completedSnapshot()),
    )).resolves.toMatchObject({
      ready: false,
      reasonCode: "INSPECTION_RESULTS_INCOMPLETE",
      missingData: { missingResultInspectionIds: ["recInspection"] },
    });
  });
});

function completedSnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    linkedInspectionRecordIds: ["recInspection"],
    sourceHospitalRecordId: "recHospital",
    selectedContactRecordIds: ["recContact"],
    fallbackContactRecordIds: [],
    ...overrides,
  };
}

function completedObservation(eventSnapshot: Record<string, unknown>): CommunicationObservation {
  return {
    sourceEntityType: "TASK",
    sourceRecordId: "recTask",
    scenario: "INSPECTION_COMPLETED",
    signature: "signature",
    fingerprintPayload: [],
    eventSnapshot,
    unknownPair: false,
  };
}

function registryFixture() {
  let current: Record<string, any> | null = null;
  const histories: Array<Record<string, any>> = [];
  const diagnostic = {
    findUnique: vi.fn(async () => current),
    update: vi.fn(async ({ data }: any) => {
      current = current ? { ...current, ...data } : current;
      return current;
    }),
    upsert: vi.fn(async ({ create, update }: any) => {
      current = current
        ? { ...current, ...update, id: current.id }
        : { ...create, id: "diagnostic-1" };
      return current;
    }),
  };
  const history = {
    create: vi.fn(async ({ data }: any) => {
      histories.push(data);
      return data;
    }),
  };
  const prisma = {
    communicationDiagnostic: diagnostic,
    communicationDiagnosticHistory: history,
    $transaction: async (operation: (transaction: unknown) => unknown) =>
      operation({ communicationDiagnostic: diagnostic, communicationDiagnosticHistory: history }),
  } as unknown as PrismaClient;
  const log = vi.fn();
  return {
    registry: new PrismaCommunicationDiagnosticRegistry(prisma, log),
    histories,
    log,
    get current() { return current; },
  };
}
