import { describe, expect, it, vi } from "vitest";
import {
  CommunicationDeliveryCancelReason,
  CommunicationDeliveryScheduleReason,
  CommunicationDeliveryStatus,
  CommunicationScenario,
} from "../generated/prisma/enums.js";
import {
  createDeliveryPlan,
  runCommunicationDeliveryPlanner,
  type CommunicationDeliveryStore,
  type CurrentTaskState,
  type DeliveryPlan,
  type DeliveryPlanningEvent,
  type DueReminder,
  type PlannedDelivery,
} from "./communication-delivery.js";
import { parseLocalDate, reminderScheduledFor, repairBatchScheduledFor } from "./communication-time.js";

const timeZone = "Europe/Warsaw";
const eventDrivenScenarios = [
  CommunicationScenario.INSPECTION_DATE_PROPOSED,
  CommunicationScenario.INSPECTION_DATE_CONFIRMED,
  CommunicationScenario.INSPECTION_COMPLETED,
] as const;

describe("event-driven communication delivery", () => {
  it.each(eventDrivenScenarios)("creates an immediate READY delivery for %s", async (scenario) => {
    const now = new Date("2026-08-13T08:00:00.000Z");
    const store = new MemoryDeliveryStore([event(scenario, ["recipientA"])]);
    await planner(store, now);
    expect(store.deliveries).toMatchObject([{
      scenario,
      status: CommunicationDeliveryStatus.READY,
      scheduleReason: CommunicationDeliveryScheduleReason.EVENT_DRIVEN,
      scheduledFor: new Date("2026-08-13T07:00:00.000Z"),
      readyAt: now,
    }]);
  });

  it("batches repair events at the next 06:00/14:00 Warsaw boundary", () => {
    const source = event(CommunicationScenario.REPAIR_RECEIVED, ["recipientA"]);
    const beforeBoundary = createDeliveryPlan(source, "recipientA", new Date("2026-08-13T08:00:00Z"), timeZone);
    expect(beforeBoundary.scheduledFor).toEqual(new Date("2026-08-13T12:00:00Z"));
    expect(beforeBoundary.status).toBe(CommunicationDeliveryStatus.SCHEDULED);
    const recoveredAfterBoundary = createDeliveryPlan(source, "recipientA", new Date("2026-08-13T12:01:00Z"), timeZone);
    expect(recoveredAfterBoundary.status).toBe(CommunicationDeliveryStatus.READY);
  });

  it("transitions a scheduled repair batch to READY at 14:00 Warsaw", async () => {
    const store = new MemoryDeliveryStore([event(CommunicationScenario.REPAIR_COMPLETED, ["recipientA"])]);
    await planner(store, new Date("2026-08-13T08:00:00Z"));
    expect(store.deliveries[0]?.status).toBe(CommunicationDeliveryStatus.SCHEDULED);
    await planner(store, new Date("2026-08-13T12:00:00Z"));
    expect(store.deliveries[0]?.status).toBe(CommunicationDeliveryStatus.READY);
  });

  it("creates a terminal delivery when a new event has no hospital scope", async () => {
    const source = event(CommunicationScenario.REPAIR_COMPLETED, ["recipientA"]);
    source.eventSnapshot = {};
    const store = new MemoryDeliveryStore([source]);
    await planner(store, new Date("2026-08-13T08:00:00Z"));
    expect(store.deliveries[0]).toMatchObject({
      status: CommunicationDeliveryStatus.CANCELLED,
      cancelReason: CommunicationDeliveryCancelReason.MISSING_HOSPITAL_SCOPE,
      readyAt: null,
    });
  });
});

describe("inspection reminder scheduling", () => {
  it("schedules a 15 August visit for 14 August at 06:00 Warsaw", async () => {
    const store = reminderStore();
    await planner(store, new Date("2026-08-13T08:00:00Z"));
    expect(store.deliveries[0]).toMatchObject({
      status: CommunicationDeliveryStatus.SCHEDULED,
      scheduledFor: new Date("2026-08-14T04:00:00Z"),
      scheduleReason: CommunicationDeliveryScheduleReason.REMINDER_0600,
    });
  });

  it("remains SCHEDULED at 05:59 Warsaw", async () => {
    const store = reminderStore();
    await planner(store, new Date("2026-08-13T08:00:00Z"));
    await planner(store, new Date("2026-08-14T03:59:00Z"));
    expect(store.deliveries[0]?.status).toBe(CommunicationDeliveryStatus.SCHEDULED);
  });

  it("becomes READY exactly at 06:00 Warsaw after validating TrackedTask", async () => {
    const store = reminderStore();
    await planner(store, new Date("2026-08-13T08:00:00Z"));
    await planner(store, new Date("2026-08-14T04:00:00Z"));
    expect(store.deliveries[0]).toMatchObject({
      status: CommunicationDeliveryStatus.READY,
      readyAt: new Date("2026-08-14T04:00:00Z"),
    });
  });

  it("is READY immediately when recovered at 07:00 and the visit is still tomorrow", async () => {
    const plan = createDeliveryPlan(
      reminderEvent(["recipientA"]),
      "recipientA",
      new Date("2026-08-14T05:00:00Z"),
      timeZone,
    );
    expect(plan.status).toBe(CommunicationDeliveryStatus.READY);
  });

  it("is CANCELLED as REMINDER_EXPIRED on the visit day", () => {
    const plan = createDeliveryPlan(
      reminderEvent(["recipientA"]),
      "recipientA",
      new Date("2026-08-15T00:00:00Z"),
      timeZone,
    );
    expect(plan).toMatchObject({
      status: CommunicationDeliveryStatus.CANCELLED,
      cancelReason: CommunicationDeliveryCancelReason.REMINDER_EXPIRED,
    });
  });

  it("cancels the old reminder when the visit date changes before readiness", async () => {
    const store = reminderStore();
    await planner(store, new Date("2026-08-13T08:00:00Z"));
    store.currentTask = { ...currentTask(), day: "2026-08-20" };
    await planner(store, new Date("2026-08-14T04:00:00Z"));
    expect(store.deliveries[0]).toMatchObject({
      status: CommunicationDeliveryStatus.CANCELLED,
      cancelReason: CommunicationDeliveryCancelReason.SOURCE_STATE_CHANGED,
    });
  });

  it.each([
    ["emmaCustomerStatus", "changed"],
    ["emmaMailTemplate", "changed"],
    ["completed", true],
  ] as const)("cancels when current %s no longer matches the event", async (field, value) => {
    const store = reminderStore();
    await planner(store, new Date("2026-08-13T08:00:00Z"));
    store.currentTask = { ...currentTask(), [field]: value };
    await planner(store, new Date("2026-08-14T04:00:00Z"));
    expect(store.deliveries[0]?.cancelReason).toBe(
      CommunicationDeliveryCancelReason.SOURCE_STATE_CHANGED,
    );
  });

  it("cancels a reminder with an invalid visit date", () => {
    const source = reminderEvent(["recipientA"]);
    source.eventSnapshot = { ...reminderSnapshot(), day: "not-a-date" };
    expect(createDeliveryPlan(source, "recipientA", new Date(), timeZone)).toMatchObject({
      status: CommunicationDeliveryStatus.CANCELLED,
      cancelReason: CommunicationDeliveryCancelReason.INVALID_REMINDER_DATE,
    });
  });
});

describe("Europe/Warsaw timezone", () => {
  it("maps winter 06:00 CET to 05:00 UTC", () => {
    expect(reminderScheduledFor(parseLocalDate("2026-01-15")!, timeZone).toISOString())
      .toBe("2026-01-14T05:00:00.000Z");
  });

  it("maps summer 06:00 CEST to 04:00 UTC", () => {
    expect(reminderScheduledFor(parseLocalDate("2026-08-15")!, timeZone).toISOString())
      .toBe("2026-08-14T04:00:00.000Z");
  });

  it("maps repair windows to local 06:00 and 14:00 across DST", () => {
    expect(repairBatchScheduledFor(new Date("2026-08-13T03:00:00Z"), timeZone).toISOString())
      .toBe("2026-08-13T04:00:00.000Z");
    expect(repairBatchScheduledFor(new Date("2026-08-13T07:00:00Z"), timeZone).toISOString())
      .toBe("2026-08-13T12:00:00.000Z");
    expect(repairBatchScheduledFor(new Date("2026-01-13T14:30:00Z"), timeZone).toISOString())
      .toBe("2026-01-14T05:00:00.000Z");
  });
});

describe("delivery multiplicity, idempotency and processedAt", () => {
  it("creates one delivery per each of three recipients", async () => {
    const store = new MemoryDeliveryStore([
      event(CommunicationScenario.INSPECTION_COMPLETED, ["a", "b", "c"]),
    ]);
    await planner(store, new Date("2026-08-13T08:00:00Z"));
    expect(store.deliveries).toHaveLength(3);
  });

  it("creates one delivery for a fallback recipient", async () => {
    const store = new MemoryDeliveryStore([
      event(CommunicationScenario.REPAIR_RECEIVED, ["fallbackRecipient"]),
    ]);
    await planner(store, new Date("2026-08-13T08:00:00Z"));
    expect(store.deliveries).toHaveLength(1);
  });

  it("100 planner runs retain one delivery per event and recipient", async () => {
    const store = new MemoryDeliveryStore([
      event(CommunicationScenario.REPAIR_RECEIVED, ["recipientA"]),
    ]);
    for (let run = 0; run < 100; run += 1) {
      await planner(store, new Date("2026-08-13T08:00:00Z"));
    }
    expect(store.deliveries).toHaveLength(1);
  });

  it("does not set processedAt before all deliveries exist", () => {
    const store = new MemoryDeliveryStore([
      event(CommunicationScenario.REPAIR_RECEIVED, ["a", "b"]),
    ]);
    expect(store.processedEvents.size).toBe(0);
  });

  it("sets processedAt only after every recipient has a delivery", async () => {
    const source = event(CommunicationScenario.REPAIR_RECEIVED, ["a", "b"]);
    const store = new MemoryDeliveryStore([source]);
    await planner(store, new Date("2026-08-13T08:00:00Z"));
    expect(store.deliveries).toHaveLength(2);
    expect(store.processedEvents.has(source.id)).toBe(true);
  });

  it("creates no delivery while recipient resolution is unresolved", async () => {
    const store = new MemoryDeliveryStore([]);
    await planner(store, new Date("2026-08-13T08:00:00Z"));
    expect(store.deliveries).toHaveLength(0);
  });

  it("creates delivery after a successful recipient-resolution retry", async () => {
    const store = new MemoryDeliveryStore([]);
    await planner(store, new Date("2026-08-13T08:00:00Z"));
    store.events.push(event(CommunicationScenario.REPAIR_RECEIVED, ["recipientAfterRetry"]));
    await planner(store, new Date("2026-08-13T08:01:00Z"));
    expect(store.deliveries).toHaveLength(1);
  });
});

describe("delivery planner safety", () => {
  it("does not create NotificationBuffer, Digest, AccessLink or call Resend", async () => {
    const resend = vi.fn();
    const store = new MemoryDeliveryStore([
      event(CommunicationScenario.REPAIR_RECEIVED, ["recipientA"]),
    ]);
    await planner(store, new Date("2026-08-13T08:00:00Z"));
    expect(store.notificationBuffersCreated).toBe(0);
    expect(store.digestsCreated).toBe(0);
    expect(store.accessLinksCreated).toBe(0);
    expect(store.portalAccessGrantsCreated).toBe(0);
    expect(resend).not.toHaveBeenCalled();
  });

  it("logs no email, personal data or event snapshot", async () => {
    const logs: string[] = [];
    const store = new MemoryDeliveryStore([
      event(CommunicationScenario.REPAIR_RECEIVED, ["recipientA"]),
    ]);
    await runCommunicationDeliveryPlanner({
      store, timeZone, now: () => new Date("2026-08-13T08:00:00Z"),
      log: (message) => logs.push(message),
    });
    expect(logs.join(" ")).toContain("COMMUNICATION_DELIVERY_CREATED");
    expect(logs.join(" ")).not.toContain("example.com");
    expect(logs.join(" ")).not.toContain("emmaCustomerStatus");
  });
});

class MemoryDeliveryStore implements CommunicationDeliveryStore {
  deliveries: PlannedDelivery[] = [];
  processedEvents = new Set<string>();
  currentTask: CurrentTaskState | null = currentTask();
  notificationBuffersCreated = 0;
  digestsCreated = 0;
  accessLinksCreated = 0;
  portalAccessGrantsCreated = 0;

  constructor(public events: DeliveryPlanningEvent[]) {}

  async findEventsAwaitingDelivery() {
    return this.events.filter((item) => !this.processedEvents.has(item.id));
  }

  async ensureDeliveries(event: DeliveryPlanningEvent, plans: readonly DeliveryPlan[]) {
    const created: PlannedDelivery[] = [];
    for (const plan of plans) {
      if (this.deliveries.some((item) =>
        item.eventId === event.id && item.recipientId === plan.recipientId)) continue;
      const delivery = {
        ...plan,
        id: `delivery-${this.deliveries.length + 1}`,
        eventId: event.id,
        scenario: event.scenario,
      };
      this.deliveries.push(delivery);
      created.push(delivery);
    }
    if (plans.length > 0 && plans.every((plan) => this.deliveries.some((item) =>
      item.eventId === event.id && item.recipientId === plan.recipientId))) {
      this.processedEvents.add(event.id);
    }
    return created;
  }

  async findDueReminders(now: Date): Promise<DueReminder[]> {
    return this.deliveries
      .filter((item) => [
        CommunicationScenario.INSPECTION_REMINDER,
        CommunicationScenario.REPAIR_RECEIVED,
        CommunicationScenario.REPAIR_COMPLETED,
      ].includes(item.scenario) &&
        item.status === CommunicationDeliveryStatus.SCHEDULED &&
        item.scheduledFor.getTime() <= now.getTime())
      .map((item) => {
        const source = this.events.find((candidate) => candidate.id === item.eventId)!;
        return {
          id: item.id,
          eventId: item.eventId,
          sourceRecordId: source.sourceRecordId,
          scenario: item.scenario,
          eventSnapshot: source.eventSnapshot,
          scheduledFor: item.scheduledFor,
        };
      });
  }

  async getCurrentTask() { return this.currentTask; }

  async transitionReminder(
    deliveryId: string,
    status: typeof CommunicationDeliveryStatus.READY | typeof CommunicationDeliveryStatus.CANCELLED,
    at: Date,
    cancelReason: CommunicationDeliveryCancelReason | null,
  ) {
    const delivery = this.deliveries.find((item) => item.id === deliveryId);
    if (!delivery || delivery.status !== CommunicationDeliveryStatus.SCHEDULED) return false;
    delivery.status = status;
    delivery.readyAt = status === CommunicationDeliveryStatus.READY ? at : null;
    delivery.cancelReason = cancelReason;
    return true;
  }
}

function planner(store: MemoryDeliveryStore, now: Date) {
  return runCommunicationDeliveryPlanner({ store, timeZone, now: () => now });
}

function event(
  scenario: CommunicationScenario,
  recipientIds: string[],
): DeliveryPlanningEvent {
  return {
    id: `event-${scenario}`,
    sourceRecordId: "recTask",
    scenario,
    detectedAt: new Date("2026-08-13T07:00:00Z"),
    eventSnapshot: scenario === CommunicationScenario.INSPECTION_REMINDER
      ? reminderSnapshot()
      : { sourceHospitalRecordId: "recHospital" },
    recipients: recipientIds.map((id) => ({ id })),
  };
}

function reminderEvent(recipientIds: string[]) {
  return event(CommunicationScenario.INSPECTION_REMINDER, recipientIds);
}

function reminderStore() {
  return new MemoryDeliveryStore([reminderEvent(["recipientA"])]);
}

function reminderSnapshot() {
  return {
    sourceHospitalRecordId: "recHospital",
    day: "2026-08-15",
    emmaCustomerStatus: "Wizyta potwierdzona",
    emmaMailTemplate: "Przegląd-przypomnienie_o_wizycie",
    completed: false,
  };
}

function currentTask(): CurrentTaskState {
  return { ...reminderSnapshot() };
}
