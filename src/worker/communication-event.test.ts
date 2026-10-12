import { describe, expect, it, vi } from "vitest";
import { CaseType } from "../generated/prisma/enums.js";
import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import type { MappedCase } from "../airtable/mappers.js";
import type { MappedTask } from "../airtable/task.js";
import {
  buildServiceOrderObservation,
  buildTaskObservation,
  createCommunicationFingerprint,
  observeCommunication,
  PrismaCommunicationEventStore,
  type CommunicationEventStore,
} from "./communication-event.js";

describe("communication event diagnostics and snapshots", () => {
  it("creates an event after a previously suppressed identical observation", async () => {
    let cursor: any = null;
    const events: any[] = [];
    const transaction = {
      communicationCursor: {
        findUnique: vi.fn(async () => cursor),
        create: vi.fn(async ({ data }: any) => {
          cursor = { id: "cursor-1", lastEventRevision: null, ...data };
          return cursor;
        }),
        update: vi.fn(async ({ data }: any) => {
          cursor = { ...cursor, ...data };
          return cursor;
        }),
      },
      communicationEvent: {
        findUnique: vi.fn(async ({ where }: any) =>
          events.find((event) => event.fingerprint === where.fingerprint) ?? null),
        create: vi.fn(async ({ data }: any) => {
          const event = { id: `event-${events.length + 1}`, ...data };
          events.push(event);
          return event;
        }),
      },
    };
    const prisma = {
      $transaction: async (operation: (tx: unknown) => unknown) => operation(transaction),
    } as unknown as PrismaClient;
    const store = new PrismaCommunicationEventStore(prisma);
    const observation = buildTaskObservation({
      ...mappedTask(),
      completed: true,
      day: "2026-08-12",
      emmaCustomerStatus: "Wizyta zakończona",
      emmaMailTemplate: "Przegląd-podsumowanie_wizyty",
    }, detectedAt);

    expect((await store.observe(observation, false, detectedAt, true)).outcome).toBe("SUPPRESSED");
    expect((await store.observe(observation, true, detectedAt)).outcome).toBe("CREATED");
    expect((await store.observe(observation, true, detectedAt)).outcome).toBe("UNCHANGED");
    expect(events).toHaveLength(1);
  });

  it("does not replay an identical permanently suppressed observation", async () => {
    let cursor: any = null;
    const events: any[] = [];
    const transaction = {
      communicationCursor: {
        findUnique: vi.fn(async () => cursor),
        create: vi.fn(async ({ data }: any) => {
          cursor = { id: "cursor-1", lastEventRevision: null, pendingEventRevision: null, ...data };
          return cursor;
        }),
        update: vi.fn(async ({ data }: any) => {
          cursor = { ...cursor, ...data };
          return cursor;
        }),
      },
      communicationEvent: {
        findUnique: vi.fn(async ({ where }: any) =>
          events.find((event) => event.fingerprint === where.fingerprint) ?? null),
        create: vi.fn(async ({ data }: any) => {
          const event = { id: `event-${events.length + 1}`, ...data };
          events.push(event);
          return event;
        }),
      },
    };
    const prisma = {
      $transaction: async (operation: (tx: unknown) => unknown) => operation(transaction),
    } as unknown as PrismaClient;
    const store = new PrismaCommunicationEventStore(prisma);
    const observation = buildTaskObservation({
      ...mappedTask(),
      completed: true,
      day: "2025-08-12",
      emmaCustomerStatus: "Wizyta zakończona",
      emmaMailTemplate: "Przegląd-podsumowanie_wizyty",
    }, detectedAt);

    expect((await store.observe(observation, false, detectedAt)).outcome).toBe("SUPPRESSED");
    expect((await store.observe(observation, true, detectedAt)).outcome).toBe("UNCHANGED");
    expect(events).toHaveLength(0);
  });

  it("does not treat the caller's retry policy as a persisted pending transition", async () => {
    let cursor: any = null;
    const events: any[] = [];
    const transaction = {
      communicationCursor: {
        findUnique: vi.fn(async () => cursor),
        create: vi.fn(async ({ data }: any) => {
          cursor = { id: "cursor-1", lastEventRevision: null, pendingEventRevision: null, ...data };
          return cursor;
        }),
        update: vi.fn(async ({ data }: any) => {
          cursor = { ...cursor, ...data };
          return cursor;
        }),
      },
      communicationEvent: {
        findUnique: vi.fn(async () => null),
        create: vi.fn(async ({ data }: any) => {
          const event = { id: `event-${events.length + 1}`, ...data };
          events.push(event);
          return event;
        }),
      },
    };
    const prisma = {
      $transaction: async (operation: (tx: unknown) => unknown) => operation(transaction),
    } as unknown as PrismaClient;
    const store = new PrismaCommunicationEventStore(prisma);
    const observation = buildTaskObservation({
      ...mappedTask(),
      completed: true,
      day: "2026-08-12",
      emmaCustomerStatus: "Wizyta zakończona",
      emmaMailTemplate: "Przegląd-podsumowanie_wizyty",
    }, detectedAt);

    await store.observe(observation, false, detectedAt, false);
    expect((await store.observe(observation, true, detectedAt, true)).outcome).toBe("UNCHANGED");
    expect(events).toHaveLength(0);
  });

  it("clears a stale pending marker for an already emitted revision", async () => {
    const observation = buildTaskObservation({
      ...mappedTask(),
      completed: true,
      day: "2026-08-12",
      emmaCustomerStatus: "Wizyta zakończona",
      emmaMailTemplate: "Przegląd-podsumowanie_wizyty",
    }, detectedAt);
    let cursor = {
      id: "cursor-1",
      lastSignature: observation.signature,
      revision: 4,
      lastEventRevision: 4,
      pendingEventRevision: 4,
    };
    const transaction = {
      communicationCursor: {
        findUnique: vi.fn(async () => cursor),
        update: vi.fn(async ({ data }: any) => {
          cursor = { ...cursor, ...data };
          return cursor;
        }),
      },
      communicationEvent: { findUnique: vi.fn(), create: vi.fn() },
    };
    const prisma = {
      $transaction: async (operation: (tx: unknown) => unknown) => operation(transaction),
    } as unknown as PrismaClient;

    const result = await new PrismaCommunicationEventStore(prisma)
      .observe(observation, false, detectedAt, true);

    expect(result.outcome).toBe("UNCHANGED");
    expect(cursor.pendingEventRevision).toBeNull();
    expect(transaction.communicationEvent.create).not.toHaveBeenCalled();
  });

  it("adopts a legacy existing matching fingerprint and repairs lastEventRevision", async () => {
    const observation = buildTaskObservation({
      ...mappedTask(),
      completed: true,
      day: "2026-08-12",
      emmaCustomerStatus: "Wizyta zakończona",
      emmaMailTemplate: "Przegląd-podsumowanie_wizyty",
    }, detectedAt);
    const fingerprint = createCommunicationFingerprint(observation, 0);
    let cursor = {
      id: "cursor-1",
      lastSignature: observation.signature,
      revision: 0,
      lastEventRevision: null,
      pendingEventRevision: 0,
    };
    const eventCreate = vi.fn();
    const transaction = {
      communicationCursor: {
        findUnique: vi.fn(async () => cursor),
        update: vi.fn(async ({ data }: any) => {
          cursor = { ...cursor, ...data };
          return cursor;
        }),
      },
      communicationEvent: {
        findUnique: vi.fn(async () => ({
          id: "existing-event",
          sourceEntityType: "TASK",
          sourceRecordId: observation.sourceRecordId,
          scenario: observation.scenario,
          // The worker version running during an additive migration did not
          // persist communicationRevision in otherwise identical events.
          eventSnapshot: observation.eventSnapshot,
        })),
        create: eventCreate,
      },
    };
    const prisma = {
      $transaction: async (operation: (tx: unknown) => unknown) => operation(transaction),
    } as unknown as PrismaClient;

    const result = await new PrismaCommunicationEventStore(prisma)
      .observe(observation, true, detectedAt, true);

    expect(result).toMatchObject({
      outcome: "UNCHANGED",
      fingerprint,
      eventId: "existing-event",
    });
    expect(cursor.lastEventRevision).toBe(0);
    expect(cursor.pendingEventRevision).toBeNull();
    expect(eventCreate).not.toHaveBeenCalled();
  });

  it("rejects an existing fingerprint that belongs to different event semantics", async () => {
    const observation = buildTaskObservation({
      ...mappedTask(),
      completed: true,
      day: "2026-08-12",
      emmaCustomerStatus: "Wizyta zakończona",
      emmaMailTemplate: "Przegląd-podsumowanie_wizyty",
    }, detectedAt);
    const transaction = {
      communicationCursor: {
        findUnique: vi.fn(async () => ({
          id: "cursor-1",
          lastSignature: observation.signature,
          revision: 0,
          lastEventRevision: null,
          pendingEventRevision: 0,
        })),
        update: vi.fn(async () => undefined),
      },
      communicationEvent: {
        findUnique: vi.fn(async () => ({
          id: "conflicting-event",
          sourceEntityType: "TASK",
          sourceRecordId: "different-task",
          scenario: observation.scenario,
          eventSnapshot: { communicationRevision: 0 },
        })),
        create: vi.fn(),
      },
    };
    const prisma = {
      $transaction: async (operation: (tx: unknown) => unknown) => operation(transaction),
    } as unknown as PrismaClient;

    await expect(new PrismaCommunicationEventStore(prisma)
      .observe(observation, true, detectedAt, true))
      .rejects.toThrow("COMMUNICATION_FINGERPRINT_CONFLICT");
  });

  it("rejects an existing matching fingerprint with an explicit different revision", async () => {
    const observation = buildTaskObservation({
      ...mappedTask(),
      completed: true,
      day: "2026-08-12",
      emmaCustomerStatus: "Wizyta zakończona",
      emmaMailTemplate: "Przegląd-podsumowanie_wizyty",
    }, detectedAt);
    const transaction = {
      communicationCursor: {
        findUnique: vi.fn(async () => ({
          id: "cursor-1",
          lastSignature: observation.signature,
          revision: 0,
          lastEventRevision: null,
          pendingEventRevision: 0,
        })),
        update: vi.fn(async () => undefined),
      },
      communicationEvent: {
        findUnique: vi.fn(async () => ({
          id: "conflicting-event",
          sourceEntityType: "TASK",
          sourceRecordId: observation.sourceRecordId,
          scenario: observation.scenario,
          eventSnapshot: { communicationRevision: 99 },
        })),
        create: vi.fn(),
      },
    };
    const prisma = {
      $transaction: async (operation: (tx: unknown) => unknown) => operation(transaction),
    } as unknown as PrismaClient;

    await expect(new PrismaCommunicationEventStore(prisma)
      .observe(observation, true, detectedAt, true))
      .rejects.toThrow("COMMUNICATION_FINGERPRINT_CONFLICT");
  });

  it("retries a serialization conflict and observes the event created by the winning worker", async () => {
    const observation = buildTaskObservation({
      ...mappedTask(),
      completed: true,
      day: "2026-08-12",
      emmaCustomerStatus: "Wizyta zakończona",
      emmaMailTemplate: "Przegląd-podsumowanie_wizyty",
    }, detectedAt);
    const eventCreate = vi.fn();
    const transaction = {
      communicationCursor: {
        findUnique: vi.fn(async () => ({
          id: "cursor-1",
          lastSignature: observation.signature,
          revision: 0,
          lastEventRevision: 0,
          pendingEventRevision: null,
        })),
        update: vi.fn(async () => undefined),
      },
      communicationEvent: { create: eventCreate },
    };
    let transactionAttempts = 0;
    const prisma = {
      $transaction: async (operation: (tx: unknown) => unknown) => {
        transactionAttempts += 1;
        if (transactionAttempts === 1) {
          throw new Prisma.PrismaClientKnownRequestError("serialization conflict", {
            code: "P2034",
            clientVersion: "7.9.0",
          });
        }
        return operation(transaction);
      },
    } as unknown as PrismaClient;

    const result = await new PrismaCommunicationEventStore(prisma)
      .observe(observation, true, detectedAt, true);

    expect(transactionAttempts).toBe(2);
    expect(result.outcome).toBe("UNCHANGED");
    expect(eventCreate).not.toHaveBeenCalled();
  });

  it("logs an unknown non-empty pair without snapshot or personal data", async () => {
    const log = vi.fn();
    const observation = buildTaskObservation({
      ...mappedTask(),
      emmaCustomerStatus: "Nieznany stan",
      emmaMailTemplate: "Nieznany-template",
    }, detectedAt);

    await observeCommunication({
      store: staticStore("NO_SCENARIO"),
      observation,
      allowEvent: true,
      detectedAt,
      log,
    });

    expect(log).toHaveBeenCalledWith(
      "COMMUNICATION_SCENARIO_UNKNOWN sourceEntityType=TASK sourceRecordId=recTask",
    );
    expect(log.mock.calls[0]?.[0]).not.toContain("recContact");
  });

  it("does not diagnose blank state/template as an error", async () => {
    const log = vi.fn();
    const observation = buildTaskObservation({
      ...mappedTask(),
      emmaCustomerStatus: null,
      emmaMailTemplate: null,
    }, detectedAt);

    await observeCommunication({
      store: staticStore("NO_SCENARIO"),
      observation,
      allowEvent: true,
      detectedAt,
      log,
    });

    expect(log).not.toHaveBeenCalled();
  });

  it("builds the required service-order event snapshot", () => {
    const observation = buildServiceOrderObservation(mappedServiceOrder(), detectedAt);

    expect(observation.eventSnapshot).toMatchObject({
      sourceEntityType: "SERVICE_ORDER",
      sourceRecordId: "recService",
      scenario: "REPAIR_RECEIVED",
      emmaCustomerStatus: "Diagnostyka",
      emmaMailTemplate: "Naprawa-zmiana_stanu",
      businessNumber: "SO-12",
      clientOrderNumber: "CLIENT-7",
      serviceOrderType: "NAPRAWA",
      hospitalName: "Szpital Testowy",
      sourceHospitalRecordId: "recHospital",
      repairRecipientEmail: "repair@hospital.pl",
      device: {
        airtableRecordId: "recDevice",
        serialNumber: "SN-1",
      },
      detectedAt: detectedAt.toISOString(),
    });
    expect(observation.eventSnapshot).not.toHaveProperty("contactRecordIds");
  });

  it("builds the required task event snapshot without resolving emails", () => {
    const observation = buildTaskObservation(mappedTask(), detectedAt);

    expect(observation.eventSnapshot).toMatchObject({
      sourceEntityType: "TASK",
      sourceRecordId: "recTask",
      taskNumber: "12",
      scenario: "INSPECTION_DATE_CONFIRMED",
      day: "2026-09-10",
      selectedContactRecordIds: ["recContactA", "recContactB"],
      fallbackContactRecordIds: ["recHospitalContact"],
      linkedInspectionRecordIds: ["recInspectionA"],
      linkedServiceOrderRecordIds: ["recService"],
      performerRecordIds: ["recEmployee"],
      sourceHospitalRecordId: "recHospital",
      detectedAt: detectedAt.toISOString(),
    });
    expect(observation.eventSnapshot).not.toHaveProperty("email");
  });
});

const detectedAt = new Date("2026-08-12T10:00:00.000Z");

function staticStore(
  outcome: "NO_SCENARIO" | "UNCHANGED",
): CommunicationEventStore {
  return {
    async isBaselineCompleted() {
      return true;
    },
    async markBaselineCompleted() {},
    async observe() {
      return { outcome, revision: 0 };
    },
  };
}

function mappedTask(): MappedTask {
  return {
    airtableRecordId: "recTask",
    taskNumber: "12",
    day: "2026-09-10",
    department: null,
    durationSeconds: null,
    activity: "Potwierdzenie terminu",
    performerRecordIds: ["recEmployee"],
    completed: false,
    status: "Zaplanowane",
    linkedServiceOrderRecordIds: ["recService"],
    linkedInspectionRecordIds: ["recInspectionA"],
    selectedContactRecordIds: ["recContactA", "recContactB"],
    hospitalContactRecordIds: ["recHospitalContact"],
    sourceHospitalRecordId: "recHospital",
    emmaCustomerStatus: "Ustalono termin wizyty",
    emmaMailTemplate: "Przegląd-informacja_o_umówionej_wizycie",
  };
}

function mappedServiceOrder(): MappedCase {
  return {
    caseType: CaseType.SERVICE_ORDER,
    airtableRecordId: "recService",
    businessNumber: "SO-12",
    clientOrderNumber: "CLIENT-7",
    caseSubtype: "NAPRAWA",
    serviceOrderType: "NAPRAWA",
    emmaCustomerStatus: "Diagnostyka",
    emmaMailTemplate: "Naprawa-zmiana_stanu",
    caseLocation: null,
    hospitalName: "Szpital Testowy",
    sourceHospitalRecordId: "recHospital",
    deviceAirtableIds: ["recDevice"],
    deviceName: "Aparat",
    manufacturer: "Producent",
    model: "Model",
    serialNumber: "SN-1",
    inventoryNumber: "INV-1",
    currentStatus: "Legacy",
    faultDescription: "Usterka",
    repairRecipientEmail: "repair@hospital.pl",
    sourceCreatedAt: null,
    reportedAt: null,
    completedAt: null,
    sourceModifiedAt: null,
    inspectionDueDate: null,
    inspectionDueDateRaw: null,
    inspectionScheduledDate: null,
    inspectionBookingStatus: null,
    sourceSnapshot: {},
    contactRecordIds: ["recContact"],
    invalidDueDate: false,
  };
}
