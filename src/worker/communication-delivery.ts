import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import {
  CommunicationDeliveryCancelReason,
  CommunicationDeliveryScheduleReason,
  CommunicationDeliveryStatus,
  CommunicationRecipientResolutionStatus,
  CommunicationScenario,
} from "../generated/prisma/enums.js";
import {
  compareLocalDates,
  localDateAt,
  parseLocalDate,
  reminderScheduledFor,
} from "./communication-time.js";

const PLANNER_LIMIT = 50;

export type DeliveryPlanningEvent = {
  id: string;
  sourceRecordId: string;
  scenario: CommunicationScenario;
  detectedAt: Date;
  eventSnapshot: unknown;
  recipients: { id: string }[];
};

export type DeliveryPlan = {
  recipientId: string;
  status: CommunicationDeliveryStatus;
  scheduledFor: Date;
  readyAt: Date | null;
  scheduleReason: CommunicationDeliveryScheduleReason;
  cancelReason: CommunicationDeliveryCancelReason | null;
};

export type PlannedDelivery = DeliveryPlan & {
  id: string;
  eventId: string;
  scenario: CommunicationScenario;
};

export type DueReminder = {
  id: string;
  eventId: string;
  sourceRecordId: string;
  scenario: CommunicationScenario;
  eventSnapshot: unknown;
  scheduledFor: Date;
};

export type CurrentTaskState = {
  day: string | null;
  emmaCustomerStatus: string | null;
  emmaMailTemplate: string | null;
  completed: boolean | null;
};

type ReminderTransitionStatus =
  | typeof CommunicationDeliveryStatus.READY
  | typeof CommunicationDeliveryStatus.CANCELLED;

export interface CommunicationDeliveryStore {
  findEventsAwaitingDelivery(limit: number): Promise<DeliveryPlanningEvent[]>;
  ensureDeliveries(
    event: DeliveryPlanningEvent,
    plans: readonly DeliveryPlan[],
    processedAt: Date,
  ): Promise<PlannedDelivery[]>;
  findDueReminders(now: Date, limit: number): Promise<DueReminder[]>;
  getCurrentTask(sourceRecordId: string): Promise<CurrentTaskState | null>;
  transitionReminder(
    deliveryId: string,
    status: ReminderTransitionStatus,
    at: Date,
    cancelReason: CommunicationDeliveryCancelReason | null,
  ): Promise<boolean>;
}

export class PrismaCommunicationDeliveryStore implements CommunicationDeliveryStore {
  constructor(private readonly prisma: PrismaClient) {}

  async findEventsAwaitingDelivery(limit: number): Promise<DeliveryPlanningEvent[]> {
    return this.prisma.communicationEvent.findMany({
      where: {
        recipientsResolvedAt: { not: null },
        processedAt: null,
      },
      orderBy: { detectedAt: "asc" },
      take: limit,
      select: {
        id: true,
        sourceRecordId: true,
        scenario: true,
        detectedAt: true,
        eventSnapshot: true,
        recipients: {
          where: {
            resolutionStatus: {
              in: [
                CommunicationRecipientResolutionStatus.READY,
                CommunicationRecipientResolutionStatus.FALLBACK,
              ],
            },
          },
          orderBy: { id: "asc" },
          select: { id: true },
        },
      },
    });
  }

  async ensureDeliveries(
    event: DeliveryPlanningEvent,
    plans: readonly DeliveryPlan[],
    processedAt: Date,
  ): Promise<PlannedDelivery[]> {
    return this.prisma.$transaction(async (transaction) => {
      const current = await transaction.communicationEvent.findUniqueOrThrow({
        where: { id: event.id },
        select: { processedAt: true },
      });
      if (current.processedAt) return [];

      const created: PlannedDelivery[] = [];
      for (const plan of plans) {
        const existing = await transaction.communicationDelivery.findUnique({
          where: { communicationEventRecipientId: plan.recipientId },
          select: { id: true },
        });
        if (existing) continue;
        const delivery = await transaction.communicationDelivery.create({
          data: {
            communicationEventId: event.id,
            communicationEventRecipientId: plan.recipientId,
            scenario: event.scenario,
            status: plan.status,
            scheduledFor: plan.scheduledFor,
            readyAt: plan.readyAt,
            deliveryKey: `${event.id}:${plan.recipientId}`,
            scheduleReason: plan.scheduleReason,
            cancelReason: plan.cancelReason,
          },
          select: { id: true },
        });
        created.push({
          ...plan,
          id: delivery.id,
          eventId: event.id,
          scenario: event.scenario,
        });
      }

      const recipientIds = plans.map((plan) => plan.recipientId);
      const deliveryCount = await transaction.communicationDelivery.count({
        where: {
          communicationEventId: event.id,
          communicationEventRecipientId: { in: recipientIds },
        },
      });
      if (deliveryCount === plans.length) {
        await transaction.communicationEvent.update({
          where: { id: event.id },
          data: { processedAt },
        });
      }
      return created;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async findDueReminders(now: Date, limit: number): Promise<DueReminder[]> {
    const deliveries = await this.prisma.communicationDelivery.findMany({
      where: {
        scenario: CommunicationScenario.INSPECTION_REMINDER,
        status: CommunicationDeliveryStatus.SCHEDULED,
        scheduledFor: { lte: now },
      },
      orderBy: { scheduledFor: "asc" },
      take: limit,
      select: {
        id: true,
        communicationEventId: true,
        scenario: true,
        scheduledFor: true,
        communicationEvent: {
          select: {
            sourceRecordId: true,
            eventSnapshot: true,
          },
        },
      },
    });
    return deliveries.map((delivery) => ({
      id: delivery.id,
      eventId: delivery.communicationEventId,
      sourceRecordId: delivery.communicationEvent.sourceRecordId,
      scenario: delivery.scenario,
      eventSnapshot: delivery.communicationEvent.eventSnapshot,
      scheduledFor: delivery.scheduledFor,
    }));
  }

  async getCurrentTask(sourceRecordId: string): Promise<CurrentTaskState | null> {
    return this.prisma.trackedTask.findUnique({
      where: { airtableRecordId: sourceRecordId },
      select: {
        day: true,
        emmaCustomerStatus: true,
        emmaMailTemplate: true,
        completed: true,
      },
    });
  }

  async transitionReminder(
    deliveryId: string,
    status: ReminderTransitionStatus,
    at: Date,
    cancelReason: CommunicationDeliveryCancelReason | null,
  ): Promise<boolean> {
    const result = await this.prisma.communicationDelivery.updateMany({
      where: { id: deliveryId, status: CommunicationDeliveryStatus.SCHEDULED },
      data: {
        status,
        readyAt: status === CommunicationDeliveryStatus.READY ? at : null,
        cancelReason,
      },
    });
    return result.count === 1;
  }
}

export async function runCommunicationDeliveryPlanner(input: {
  store: CommunicationDeliveryStore;
  timeZone: string;
  now?: () => Date;
  log?: (message: string) => void;
}): Promise<{ eventsPlanned: number; remindersTransitioned: number }> {
  const now = input.now ?? (() => new Date());
  const planningNow = now();
  const events = await input.store.findEventsAwaitingDelivery(PLANNER_LIMIT);
  for (const event of events) {
    const plans = event.recipients.map((recipient) =>
      createDeliveryPlan(event, recipient.id, planningNow, input.timeZone));
    const created = await input.store.ensureDeliveries(event, plans, planningNow);
    for (const delivery of created) {
      if (delivery.status === CommunicationDeliveryStatus.CANCELLED) {
        input.log?.(
          `COMMUNICATION_DELIVERY_CANCELLED deliveryId=${delivery.id} ` +
          `reason=${delivery.cancelReason ?? "UNKNOWN"}`,
        );
      } else {
        input.log?.(
          `COMMUNICATION_DELIVERY_CREATED eventId=${event.id} scenario=${event.scenario} ` +
          `status=${delivery.status} scheduleReason=${delivery.scheduleReason}`,
        );
      }
    }
  }

  const transitionNow = now();
  const reminders = await input.store.findDueReminders(transitionNow, PLANNER_LIMIT);
  const taskCache = new Map<string, CurrentTaskState | null>();
  let remindersTransitioned = 0;
  for (const reminder of reminders) {
    if (!taskCache.has(reminder.sourceRecordId)) {
      taskCache.set(
        reminder.sourceRecordId,
        await input.store.getCurrentTask(reminder.sourceRecordId),
      );
    }
    const cancelReason = reminderCancellationReason(
      reminder.eventSnapshot,
      taskCache.get(reminder.sourceRecordId) ?? null,
      transitionNow,
      input.timeZone,
    );
    const transition: {
      status: ReminderTransitionStatus;
      cancelReason: CommunicationDeliveryCancelReason | null;
    } = cancelReason
      ? { status: CommunicationDeliveryStatus.CANCELLED, cancelReason }
      : { status: CommunicationDeliveryStatus.READY, cancelReason: null };
    const changed = await input.store.transitionReminder(
      reminder.id,
      transition.status,
      transitionNow,
      transition.cancelReason,
    );
    if (!changed) continue;
    remindersTransitioned += 1;
    if (transition.status === CommunicationDeliveryStatus.READY) {
      input.log?.(
        `COMMUNICATION_DELIVERY_READY deliveryId=${reminder.id} scenario=${reminder.scenario}`,
      );
    } else {
      input.log?.(
        `COMMUNICATION_DELIVERY_CANCELLED deliveryId=${reminder.id} reason=${transition.cancelReason}`,
      );
    }
  }
  return { eventsPlanned: events.length, remindersTransitioned };
}

export function createDeliveryPlan(
  event: DeliveryPlanningEvent,
  recipientId: string,
  now: Date,
  timeZone: string,
): DeliveryPlan {
  if (!snapshotString(event.eventSnapshot, "sourceHospitalRecordId")) {
    return {
      recipientId,
      status: CommunicationDeliveryStatus.CANCELLED,
      scheduledFor: event.scenario === CommunicationScenario.INSPECTION_REMINDER
        ? reminderScheduledForOrDetectedAt(event, timeZone)
        : event.detectedAt,
      readyAt: null,
      scheduleReason: event.scenario === CommunicationScenario.INSPECTION_REMINDER
        ? CommunicationDeliveryScheduleReason.REMINDER_0600
        : CommunicationDeliveryScheduleReason.EVENT_DRIVEN,
      cancelReason: CommunicationDeliveryCancelReason.MISSING_HOSPITAL_SCOPE,
    };
  }
  if (event.scenario !== CommunicationScenario.INSPECTION_REMINDER) {
    return {
      recipientId,
      status: CommunicationDeliveryStatus.READY,
      scheduledFor: event.detectedAt,
      readyAt: now,
      scheduleReason: CommunicationDeliveryScheduleReason.EVENT_DRIVEN,
      cancelReason: null,
    };
  }

  const visitDate = parseLocalDate(snapshotValue(event.eventSnapshot, "day"));
  if (!visitDate) {
    return cancelledPlan(
      recipientId,
      event.detectedAt,
      CommunicationDeliveryCancelReason.INVALID_REMINDER_DATE,
    );
  }
  const scheduledFor = reminderScheduledFor(visitDate, timeZone);
  if (compareLocalDates(localDateAt(now, timeZone), visitDate) >= 0) {
    return cancelledPlan(
      recipientId,
      scheduledFor,
      CommunicationDeliveryCancelReason.REMINDER_EXPIRED,
    );
  }
  return {
    recipientId,
    status: now.getTime() >= scheduledFor.getTime()
      ? CommunicationDeliveryStatus.READY
      : CommunicationDeliveryStatus.SCHEDULED,
    scheduledFor,
    readyAt: now.getTime() >= scheduledFor.getTime() ? now : null,
    scheduleReason: CommunicationDeliveryScheduleReason.REMINDER_0600,
    cancelReason: null,
  };
}

function reminderScheduledForOrDetectedAt(
  event: DeliveryPlanningEvent,
  timeZone: string,
): Date {
  const visitDate = parseLocalDate(snapshotValue(event.eventSnapshot, "day"));
  return visitDate ? reminderScheduledFor(visitDate, timeZone) : event.detectedAt;
}

export function reminderCancellationReason(
  eventSnapshot: unknown,
  currentTask: CurrentTaskState | null,
  now: Date,
  timeZone: string,
): CommunicationDeliveryCancelReason | null {
  if (!currentTask || !matchesEventSnapshot(currentTask, eventSnapshot)) {
    return CommunicationDeliveryCancelReason.SOURCE_STATE_CHANGED;
  }
  const visitDate = parseLocalDate(currentTask.day);
  if (!visitDate || compareLocalDates(localDateAt(now, timeZone), visitDate) >= 0) {
    return CommunicationDeliveryCancelReason.REMINDER_EXPIRED;
  }
  return null;
}

function matchesEventSnapshot(
  currentTask: CurrentTaskState,
  snapshot: unknown,
): boolean {
  return currentTask.day === snapshotValue(snapshot, "day") &&
    currentTask.emmaCustomerStatus === snapshotValue(snapshot, "emmaCustomerStatus") &&
    currentTask.emmaMailTemplate === snapshotValue(snapshot, "emmaMailTemplate") &&
    currentTask.completed === snapshotValue(snapshot, "completed");
}

function cancelledPlan(
  recipientId: string,
  scheduledFor: Date,
  cancelReason: CommunicationDeliveryCancelReason,
): DeliveryPlan {
  return {
    recipientId,
    status: CommunicationDeliveryStatus.CANCELLED,
    scheduledFor,
    readyAt: null,
    scheduleReason: CommunicationDeliveryScheduleReason.REMINDER_0600,
    cancelReason,
  };
}

function snapshotValue(snapshot: unknown, key: string): unknown {
  return typeof snapshot === "object" && snapshot !== null && !Array.isArray(snapshot)
    ? (snapshot as Record<string, unknown>)[key]
    : undefined;
}

function snapshotString(snapshot: unknown, key: string): string | null {
  const value = snapshotValue(snapshot, key);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
