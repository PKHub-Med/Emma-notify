import { isDeepStrictEqual } from "node:util";
import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import {
  CommunicationDiagnosticOrigin,
  CommunicationDiagnosticStatus,
  CommunicationScenario,
  CommunicationSourceEntityType,
  SyncEntityType,
  SyncStatus,
} from "../generated/prisma/enums.js";
import {
  AIRTABLE_TABLE_IDS,
  TASK_FIELD_IDS,
  TASK_FIELDS,
  INSPECTION_FIELDS,
} from "../airtable/field-ids.js";
import { parseAirtableDate } from "../airtable/values.js";
import { mapTask, type MappedTask } from "../airtable/task.js";
import type {
  AirtableIncrementalSource,
  AirtableListOptions,
  AirtableRecord,
  AirtableRequestMetrics,
} from "../airtable/types.js";
import {
  buildTaskObservation,
  observeCommunication,
  type CommunicationEventStore,
  type CommunicationObservation,
  type CommunicationObservationResult,
} from "./communication-event.js";
import {
  compareLocalDates,
  localDateAt,
  parseLocalDate,
} from "./communication-time.js";
import { formatIncrementalSyncFailure } from "./incremental-sync-error.js";
import {
  nextPendingCheck,
  pendingDataExpiresAt,
  type CommunicationDiagnosticRegistry,
  type CompletedDataReadiness,
  type PendingTaskDiagnostic,
} from "./communication-diagnostics.js";

export type TaskSyncMode = "BASELINE" | "INCREMENTAL" | "RECONCILE" | "REMINDER_ELIGIBILITY";
export type TaskUpsertOutcome = "FIRST_SEEN" | "UNCHANGED" | "CHANGED";
export const COMPLETED_COMMUNICATIONS_PER_RUN_LIMIT = 20;

export interface TaskSyncStore {
  markRunning(at: Date): Promise<void>;
  getCheckpoint(): Promise<{ baselineCompletedAt: Date | null; lastSuccessfulSyncAt: Date | null } | null>;
  upsertTask(task: MappedTask, seenAt: Date): Promise<TaskUpsertOutcome>;
  markSuccessful(at: Date, ensureBaseline: boolean, advanceCursor: boolean): Promise<void>;
  markFailed(at: Date): Promise<void>;
}

export type TaskSyncStats = {
  mode: TaskSyncMode;
  tasksFetched: number;
  recordsFetched: number;
  pagesFetched: number;
  requestsMade: number;
  firstSeen: number;
  changed: number;
  unchanged: number;
  durationMs: number;
};

export class PrismaTaskSyncStore implements TaskSyncStore {
  constructor(private readonly prisma: PrismaClient | Prisma.TransactionClient) {}

  async markRunning(at: Date): Promise<void> {
    await this.prisma.syncState.upsert({
      where: { source_entityType: { source: "AIRTABLE", entityType: SyncEntityType.TASK } },
      create: { source: "AIRTABLE", entityType: SyncEntityType.TASK, status: SyncStatus.RUNNING, lastAttemptAt: at },
      update: { status: SyncStatus.RUNNING, lastAttemptAt: at, lastError: null },
    });
  }

  getCheckpoint() {
    return this.prisma.syncState.findUnique({
      where: { source_entityType: { source: "AIRTABLE", entityType: SyncEntityType.TASK } },
      select: { baselineCompletedAt: true, lastSuccessfulSyncAt: true },
    });
  }

  async upsertTask(task: MappedTask, seenAt: Date): Promise<TaskUpsertOutcome> {
    return this.inTransaction(async (transaction) => {
      const existing = await transaction.trackedTask.findUnique({
        where: { airtableRecordId: task.airtableRecordId }, select: { sourceSnapshot: true },
      });
      const snapshot = buildTaskSnapshot(task);
      const data = taskData(task, snapshot, seenAt);
      await transaction.trackedTask.upsert({
        where: { airtableRecordId: task.airtableRecordId },
        create: { airtableRecordId: task.airtableRecordId, ...data, firstSeenAt: seenAt },
        update: data,
      });
      if (!existing) return "FIRST_SEEN";
      return isDeepStrictEqual(existing.sourceSnapshot, snapshot) ? "UNCHANGED" : "CHANGED";
    });
  }

  private inTransaction<T>(operation: (transaction: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    if ("$transaction" in this.prisma) {
      return this.prisma.$transaction(operation);
    }
    return operation(this.prisma);
  }

  async markSuccessful(at: Date, ensureBaseline: boolean, advanceCursor: boolean): Promise<void> {
    const current = await this.getCheckpoint();
    await this.prisma.syncState.update({
      where: { source_entityType: { source: "AIRTABLE", entityType: SyncEntityType.TASK } },
      data: {
        status: SyncStatus.IDLE,
        ...(advanceCursor ? { lastSuccessfulSyncAt: at } : {}),
        ...(ensureBaseline && !current?.baselineCompletedAt ? { baselineCompletedAt: at } : {}),
        lastError: null,
      },
    });
  }

  async markFailed(at: Date): Promise<void> {
    await this.prisma.syncState.update({
      where: { source_entityType: { source: "AIRTABLE", entityType: SyncEntityType.TASK } },
      data: { status: SyncStatus.ERROR, lastAttemptAt: at, lastError: "Task synchronization failed" },
    });
  }
}

export async function runTaskSync(dependencies: {
  airtable: AirtableIncrementalSource;
  store: TaskSyncStore;
  communicationStore: CommunicationEventStore;
  diagnostics?: CommunicationDiagnosticRegistry;
  overlapSeconds?: number;
  requestedMode?: "AUTO" | "RECONCILE" | "REMINDER_ELIGIBILITY";
  timeZone?: string;
  mailTestMode?: boolean;
  now?: () => Date;
  log?: (message: string) => void;
}): Promise<TaskSyncStats> {
  const now = dependencies.now ?? (() => new Date());
  const startedAt = now();
  try {
    await dependencies.store.markRunning(startedAt);
    const checkpoint = await dependencies.store.getCheckpoint();
    const communicationBaseline = await dependencies.communicationStore.isBaselineCompleted("TASK");
    const mode: TaskSyncMode = dependencies.requestedMode === "REMINDER_ELIGIBILITY"
      ? "REMINDER_ELIGIBILITY"
      : dependencies.requestedMode === "RECONCILE"
        ? "RECONCILE"
        : communicationBaseline ? "INCREMENTAL" : "BASELINE";
    const listOptions = mode === "INCREMENTAL"
      ? { filterByFormula: buildTaskIncrementalFormula(
          new Date((checkpoint?.lastSuccessfulSyncAt ?? startedAt).getTime() -
            (dependencies.overlapSeconds ?? 120) * 1_000),
        ) }
      : mode === "REMINDER_ELIGIBILITY"
        ? { filterByFormula: buildReminderEligibilityFormula(
            startedAt,
            dependencies.timeZone ?? "Europe/Warsaw",
          ) }
        : undefined;
    const measured = await fetchTaskRecords(
      dependencies.airtable,
      AIRTABLE_TABLE_IDS.tasks,
      TASK_FIELD_IDS,
      listOptions,
    );
    const records = [...measured.records];
    const pendingTasks = new Map<string, PendingTaskDiagnostic>();
    if (mode === "INCREMENTAL" && dependencies.diagnostics) {
      const present = new Set(records.map((record) => record.id));
      const duePending = await dependencies.diagnostics.findDuePendingTasks(startedAt);
      for (const pendingTask of duePending) {
        const recordId = pendingTask.sourceRecordId;
        pendingTasks.set(recordId, pendingTask);
        if (present.has(recordId)) continue;
        try {
          records.push(await dependencies.airtable.fetchRecord(
            AIRTABLE_TABLE_IDS.tasks,
            recordId,
            TASK_FIELD_IDS,
          ));
          present.add(recordId);
        } catch {
          const expiresAt = pendingTask.expiresAt ??
            pendingDataExpiresAt(pendingTask.firstDetectedAt);
          const expired = now().getTime() >= expiresAt.getTime();
          await dependencies.diagnostics.record({
            sourceEntityType: CommunicationSourceEntityType.TASK,
            sourceRecordId: recordId,
            scenario: CommunicationScenario.INSPECTION_COMPLETED,
            status: expired
              ? CommunicationDiagnosticStatus.BLOCKED
              : CommunicationDiagnosticStatus.PENDING_DATA,
            reasonCode: expired
              ? "PENDING_DATA_EXPIRED"
              : "AIRTABLE_TASK_REFETCH_FAILED",
            reasonOrigin: CommunicationDiagnosticOrigin.AIRTABLE,
            missingData: terminalPendingEvidence(
              pendingTask.missingData,
              pendingTask.reasonCode,
            ),
            checkedAt: now(),
            nextCheckAt: expired ? null : nextPendingCheck(now()),
            expiresAt,
          });
        }
      }
    }
    const stats: TaskSyncStats = {
      mode, tasksFetched: records.length, recordsFetched: records.length,
      pagesFetched: 0, requestsMade: 0, firstSeen: 0, changed: 0, unchanged: 0,
      durationMs: 0,
    };

    let completedEventsCreated = 0;
    let completedLimitLogged = false;
    for (const record of records) {
      const detectedAt = now();
      const task = mapTask(record);
      const observation = buildTaskObservation(task, detectedAt);
      const pendingTask = pendingTasks.get(record.id) ?? null;
      const timeZone = dependencies.timeZone ?? "Europe/Warsaw";
      const visitDateEligible = isCurrentVisitDateObservation(
        observation,
        detectedAt,
        timeZone,
      );
      const completedDateEligible = observation.scenario === "INSPECTION_COMPLETED"
        ? dependencies.mailTestMode
          ? await isCurrentlyPerformedCompletedTask(
              task,
              dependencies.airtable,
              detectedAt,
              timeZone,
            )
          : isCurrentCompletedObservation(observation, detectedAt, timeZone)
        : true;
      const automaticEventAllowed = mode === "REMINDER_ELIGIBILITY"
        ? isCurrentReminderObservation(observation, detectedAt, timeZone)
        : mode === "INCREMENTAL" &&
          visitDateEligible &&
          completedDateEligible;
      let readiness: CompletedDataReadiness = { ready: true };
      if (observation.scenario === "INSPECTION_COMPLETED" &&
          (automaticEventAllowed || pendingTask !== null ||
            (mode === "RECONCILE" && completedDateEligible)) &&
          dependencies.diagnostics) {
        readiness = await dependencies.diagnostics.assessCompletedData(observation);
      }
      const pendingExpiresAt = pendingTask
        ? pendingTask.expiresAt ?? pendingDataExpiresAt(pendingTask.firstDetectedAt)
        : pendingDataExpiresAt(detectedAt);
      const pendingDataExpired = pendingTask !== null && !readiness.ready &&
        detectedAt.getTime() >= pendingExpiresAt.getTime();
      const completedLimitReached = observation.scenario === "INSPECTION_COMPLETED" &&
        completedEventsCreated >= COMPLETED_COMMUNICATIONS_PER_RUN_LIMIT;
      if (completedLimitReached && !completedLimitLogged) {
        completedLimitLogged = true;
        dependencies.log?.(
          `ERROR COMMUNICATION_COMPLETED_SAFETY_LIMIT_REACHED ` +
          `limit=${COMPLETED_COMMUNICATIONS_PER_RUN_LIMIT} mode=${mode}`,
        );
      }
      const allowEvent = automaticEventAllowed && readiness.ready && !completedLimitReached;
      // Reconcile remains data-only, but a completion from the current business
      // day is an eligible transition which must survive until incremental can
      // run the normal readiness checks and create the event. Historical and
      // baseline observations remain permanently suppressed.
      const retryableSuppression = observation.scenario === "INSPECTION_COMPLETED" &&
        !pendingDataExpired &&
        (automaticEventAllowed || (mode === "RECONCILE" && completedDateEligible));
      const outcome = await syncSingleTaskRecord({
        record,
        store: dependencies.store,
        communicationStore: dependencies.communicationStore,
        allowEvent,
        retryableSuppression,
        detectedAt,
        ...(dependencies.log ? { log: dependencies.log } : {}),
      });
      if (outcome.communicationOutcome === "CREATED" &&
          observation.scenario === "INSPECTION_COMPLETED") {
        completedEventsCreated += 1;
      }
      if (dependencies.diagnostics) {
        await recordTaskDiagnostic({
          diagnostics: dependencies.diagnostics,
          observation,
          taskNumber: task.taskNumber,
          mode,
          automaticEventAllowed,
          deferredTransition: retryableSuppression && mode === "RECONCILE",
          readiness,
          completedLimitReached,
          outcome: outcome.communicationOutcome,
          ...(outcome.communicationEventId
            ? { eventId: outcome.communicationEventId }
            : {}),
          detectedAt,
          timeZone,
          pendingTask,
          pendingExpiresAt,
          pendingDataExpired,
        });
      }
      if (outcome.taskOutcome === "FIRST_SEEN") stats.firstSeen += 1;
      if (outcome.taskOutcome === "CHANGED") stats.changed += 1;
      if (outcome.taskOutcome === "UNCHANGED") stats.unchanged += 1;
    }

    const completedAt = now();
    if (!communicationBaseline && mode === "BASELINE") {
      await dependencies.communicationStore.markBaselineCompleted("TASK", completedAt);
    }
    await dependencies.store.markSuccessful(
      completedAt,
      mode === "BASELINE",
      mode === "BASELINE" || mode === "INCREMENTAL",
    );
    stats.pagesFetched = measured.metrics.pagesFetched;
    stats.requestsMade = measured.metrics.requestsMade;
    stats.durationMs = Math.max(0, completedAt.getTime() - startedAt.getTime());
    dependencies.log?.(formatTaskSyncStats(stats));
    if (dependencies.diagnostics) {
      const summary = await dependencies.diagnostics.summarizeCycle(startedAt);
      dependencies.log?.(
        `COMMUNICATION_CYCLE_SUMMARY checked=${summary.checked} pending=${summary.pending} ` +
        `blocked=${summary.blocked} eventsCreated=${summary.eventsCreated} sent=${summary.sent} ` +
        `cancelled=${summary.cancelled} interventionRequired=${summary.interventionRequired}`,
      );
      await dependencies.diagnostics.pruneExpired?.(completedAt);
    }
    return stats;
  } catch (error: unknown) {
    await dependencies.store.markFailed(now()).catch(() => undefined);
    const failedAt = now();
    dependencies.log?.(formatIncrementalSyncFailure({
      error,
      fallbackStage: "TASK",
      durationMs: failedAt.getTime() - startedAt.getTime(),
    }));
    throw error;
  }
}

export async function syncSingleTaskRecord(input: {
  record: AirtableRecord;
  store: Pick<TaskSyncStore, "upsertTask">;
  communicationStore: CommunicationEventStore;
  allowEvent: boolean;
  retryableSuppression?: boolean;
  detectedAt: Date;
  log?: (message: string) => void;
}): Promise<{
  taskOutcome: TaskUpsertOutcome;
  communicationOutcome: CommunicationObservationResult["outcome"];
  communicationEventId?: string;
}> {
  const task = mapTask(input.record);
  const taskOutcome = await input.store.upsertTask(task, input.detectedAt);
  const communication = await observeCommunication({
    store: input.communicationStore,
    observation: buildTaskObservation(task, input.detectedAt),
    allowEvent: input.allowEvent,
    ...(input.retryableSuppression !== undefined
      ? { retryableSuppression: input.retryableSuppression }
      : {}),
    detectedAt: input.detectedAt,
    ...(input.log ? { log: input.log } : {}),
  });
  return {
    taskOutcome,
    communicationOutcome: communication.outcome,
    ...(communication.eventId ? { communicationEventId: communication.eventId } : {}),
  };
}

async function recordTaskDiagnostic(input: {
  diagnostics: CommunicationDiagnosticRegistry;
  observation: CommunicationObservation;
  taskNumber: string | null;
  mode: TaskSyncMode;
  automaticEventAllowed: boolean;
  deferredTransition: boolean;
  readiness: CompletedDataReadiness;
  completedLimitReached: boolean;
  outcome: CommunicationObservationResult["outcome"];
  eventId?: string;
  detectedAt: Date;
  timeZone: string;
  pendingTask: PendingTaskDiagnostic | null;
  pendingExpiresAt: Date;
  pendingDataExpired: boolean;
}): Promise<void> {
  const common = {
    sourceEntityType: CommunicationSourceEntityType.TASK,
    sourceRecordId: input.observation.sourceRecordId,
    businessNumber: input.taskNumber,
    scenario: input.observation.scenario as CommunicationScenario | null,
    checkedAt: input.detectedAt,
  };
  if (!input.observation.scenario) {
    await input.diagnostics.record({
      ...common,
      status: CommunicationDiagnosticStatus.NOT_ELIGIBLE,
      reasonCode: "SCENARIO_NOT_MATCHED",
      reasonOrigin: CommunicationDiagnosticOrigin.APPLICATION,
    });
    return;
  }
  const historical = input.observation.scenario === "INSPECTION_COMPLETED" &&
    !isCurrentCompletedObservation(input.observation, input.detectedAt, input.timeZone);
  if (historical && input.pendingTask) {
    if (input.readiness.ready) {
      await input.diagnostics.record({
        ...common,
        status: CommunicationDiagnosticStatus.BLOCKED,
        reasonCode: "READY_BUT_HISTORICAL",
        reasonOrigin: CommunicationDiagnosticOrigin.APPLICATION,
        missingData: terminalPendingEvidence(
          input.pendingTask.missingData,
          input.pendingTask.reasonCode,
        ),
        expiresAt: input.pendingExpiresAt,
      });
      return;
    }
    if (input.pendingDataExpired) {
      await input.diagnostics.record({
        ...common,
        status: CommunicationDiagnosticStatus.BLOCKED,
        reasonCode: "PENDING_DATA_EXPIRED",
        reasonOrigin: CommunicationDiagnosticOrigin.SYNC,
        missingData: terminalPendingEvidence(
          input.readiness.missingData,
          input.readiness.reasonCode,
        ),
        expiresAt: input.pendingExpiresAt,
      });
      return;
    }
    await input.diagnostics.record({
      ...common,
      status: CommunicationDiagnosticStatus.PENDING_DATA,
      reasonCode: input.readiness.reasonCode,
      reasonOrigin: CommunicationDiagnosticOrigin.SYNC,
      missingData: input.readiness.missingData,
      nextCheckAt: nextPendingCheck(input.detectedAt),
      expiresAt: input.pendingExpiresAt,
    });
    return;
  }
  if (!input.automaticEventAllowed) {
    if (input.deferredTransition) {
      await input.diagnostics.record({
        ...common,
        status: CommunicationDiagnosticStatus.PENDING_DATA,
        reasonCode: input.readiness.ready
          ? "RECONCILE_DEFERRED"
          : input.readiness.reasonCode,
        reasonOrigin: CommunicationDiagnosticOrigin.SYNC,
        missingData: input.readiness.ready ? null : input.readiness.missingData,
        nextCheckAt: nextPendingCheck(input.detectedAt),
        expiresAt: input.pendingExpiresAt,
      });
      return;
    }
    await input.diagnostics.record({
      ...common,
      status: historical && input.mode === "INCREMENTAL"
        ? CommunicationDiagnosticStatus.BLOCKED
        : CommunicationDiagnosticStatus.NOT_ELIGIBLE,
      reasonCode: historical ? "HISTORICAL_COMPLETED" : `MODE_${input.mode}`,
      reasonOrigin: CommunicationDiagnosticOrigin.APPLICATION,
    });
    return;
  }
  if (!input.readiness.ready) {
    await input.diagnostics.record({
      ...common,
      status: input.pendingDataExpired
        ? CommunicationDiagnosticStatus.BLOCKED
        : CommunicationDiagnosticStatus.PENDING_DATA,
      reasonCode: input.pendingDataExpired
        ? "PENDING_DATA_EXPIRED"
        : input.readiness.reasonCode,
      reasonOrigin: CommunicationDiagnosticOrigin.SYNC,
      missingData: input.pendingDataExpired
        ? terminalPendingEvidence(input.readiness.missingData, input.readiness.reasonCode)
        : input.readiness.missingData,
      nextCheckAt: input.pendingDataExpired ? null : nextPendingCheck(input.detectedAt),
      expiresAt: input.pendingExpiresAt,
    });
    return;
  }
  if (input.completedLimitReached) {
    await input.diagnostics.record({
      ...common,
      status: CommunicationDiagnosticStatus.PENDING_DATA,
      reasonCode: "COMPLETED_SAFETY_LIMIT",
      reasonOrigin: CommunicationDiagnosticOrigin.APPLICATION,
      nextCheckAt: nextPendingCheck(input.detectedAt),
      expiresAt: input.pendingExpiresAt,
    });
    return;
  }
  await input.diagnostics.record({
    ...common,
    status: CommunicationDiagnosticStatus.READY,
    reasonCode: input.outcome === "CREATED" ? "EVENT_CREATED" : "EVENT_ALREADY_EXISTS",
    reasonOrigin: CommunicationDiagnosticOrigin.APPLICATION,
    eventId: input.eventId ?? null,
  });
}

function terminalPendingEvidence(
  missingData: Record<string, unknown> | null,
  lastPendingReasonCode: string,
): Record<string, unknown> {
  return {
    ...(missingData ?? {}),
    lastPendingReasonCode,
  };
}

export function isCurrentCompletedObservation(
  observation: CommunicationObservation,
  now: Date,
  timeZone: string,
): boolean {
  if (observation.scenario !== "INSPECTION_COMPLETED") return true;
  const businessDate = parseLocalDate(observation.eventSnapshot.day);
  return businessDate !== null &&
    compareLocalDates(businessDate, localDateAt(now, timeZone)) === 0;
}

export function isCurrentVisitDateObservation(
  observation: CommunicationObservation,
  now: Date,
  timeZone: string,
): boolean {
  if (observation.scenario !== "INSPECTION_DATE_CONFIRMED" &&
      observation.scenario !== "INSPECTION_DATE_PROPOSED") return true;
  const visitDate = parseLocalDate(observation.eventSnapshot.day);
  return visitDate !== null &&
    compareLocalDates(visitDate, localDateAt(now, timeZone)) >= 0;
}

export async function isCurrentlyPerformedCompletedTask(
  task: MappedTask,
  airtable: AirtableIncrementalSource,
  now: Date,
  timeZone: string,
): Promise<boolean> {
  const observation = buildTaskObservation(task, now);
  if (observation.scenario !== "INSPECTION_COMPLETED") return true;
  if (task.linkedInspectionRecordIds.length === 0) return false;
  const today = localDateAt(now, timeZone);
  try {
    const performedDates = await Promise.all(task.linkedInspectionRecordIds.map(async (recordId) => {
      const record = await airtable.fetchRecord(
        AIRTABLE_TABLE_IDS.inspections,
        recordId,
        [INSPECTION_FIELDS.performedAt],
      );
      return parseAirtableDate(record.fields[INSPECTION_FIELDS.performedAt]);
    }));
    return performedDates.every((performedAt) => performedAt !== null &&
      compareLocalDates(localDateAt(performedAt, timeZone), today) === 0);
  } catch {
    return false;
  }
}

export function isCurrentReminderObservation(
  observation: CommunicationObservation,
  now: Date,
  timeZone: string,
): boolean {
  if (observation.scenario !== "INSPECTION_REMINDER") return false;
  const visitDate = parseLocalDate(observation.eventSnapshot.day);
  const tomorrow = parseLocalDate(addDaysToZonedDate(dateInTimeZone(now, timeZone), 1));
  return visitDate !== null && tomorrow !== null &&
    compareLocalDates(visitDate, tomorrow) === 0;
}

export const TASK_EDITABLE_FIELD_IDS = [
  TASK_FIELDS.day,
  TASK_FIELDS.plannedDay,
  TASK_FIELDS.activity,
  TASK_FIELDS.assigneeLinks,
  TASK_FIELDS.completed,
  TASK_FIELDS.status,
  TASK_FIELDS.serviceOrderLinks,
  TASK_FIELDS.inspectionLinks,
  TASK_FIELDS.selectedContactLinks,
] as const;

export function buildTaskIncrementalFormula(since: Date): string {
  const fields = TASK_EDITABLE_FIELD_IDS.map((id) => `{${id}}`).join(",");
  return `IS_AFTER(LAST_MODIFIED_TIME(${fields}), DATETIME_PARSE('${since.toISOString()}'))`;
}

export function buildTaskPollingFormula(): string {
  return buildTaskIncrementalFormula(new Date(0));
}

export function buildReminderEligibilityFormula(
  now: Date,
  timeZone = "Europe/Warsaw",
): string {
  const tomorrow = addDaysToZonedDate(dateInTimeZone(now, timeZone), 1);
  return `AND(DATETIME_FORMAT(SET_TIMEZONE({${TASK_FIELDS.day}}, '${timeZone}'), 'YYYY-MM-DD') = '${tomorrow}', {${TASK_FIELDS.emmaMailTemplate}} = 'Przegląd-przypomnienie_o_wizycie', {${TASK_FIELDS.emmaCustomerStatus}} = 'Przypomnienie o wizycie')`;
}

export function buildTaskSnapshot(task: MappedTask) {
  const { airtableRecordId: _airtableRecordId, ...snapshot } = task;
  return snapshot;
}

export function formatTaskSyncStats(stats: TaskSyncStats): string {
  return `AIRTABLE_SYNC_STATS entityType=TASK mode=${stats.mode} recordsFetched=${stats.recordsFetched} pagesFetched=${stats.pagesFetched} requestsMade=${stats.requestsMade} durationMs=${stats.durationMs}`;
}

function requestMetrics(source: AirtableIncrementalSource): AirtableRequestMetrics {
  const metricsSource = source as AirtableIncrementalSource & {
    getRequestMetrics?: () => AirtableRequestMetrics;
  };
  return metricsSource.getRequestMetrics?.() ?? { requestsMade: 0, pagesFetched: 0 };
}

async function fetchTaskRecords(
  source: AirtableIncrementalSource,
  tableId: string,
  fieldIds: readonly string[],
  options?: AirtableListOptions,
): Promise<{ records: AirtableRecord[]; metrics: AirtableRequestMetrics }> {
  const measuredSource = source as AirtableIncrementalSource & {
    fetchAllRecordsWithMetrics?: (
      tableId: string,
      fieldIds: readonly string[],
      options?: AirtableListOptions,
    ) => Promise<{ records: AirtableRecord[]; metrics: AirtableRequestMetrics }>;
  };
  if (measuredSource.fetchAllRecordsWithMetrics) {
    return measuredSource.fetchAllRecordsWithMetrics(tableId, fieldIds, options);
  }
  const before = requestMetrics(source);
  const records = await source.fetchAllRecords(tableId, fieldIds, options);
  const after = requestMetrics(source);
  return {
    records,
    metrics: {
      pagesFetched: after.pagesFetched - before.pagesFetched,
      requestsMade: after.requestsMade - before.requestsMade,
    },
  };
}

function taskData(task: MappedTask, snapshot: ReturnType<typeof buildTaskSnapshot>, seenAt: Date) {
  return {
    taskNumber: task.taskNumber, day: task.day, activity: task.activity,
    completed: task.completed, status: task.status,
    emmaCustomerStatus: task.emmaCustomerStatus, emmaMailTemplate: task.emmaMailTemplate,
    sourceHospitalRecordId: task.sourceHospitalRecordId,
    selectedContactRecordIds: task.selectedContactRecordIds as Prisma.InputJsonArray,
    linkedInspectionRecordIds: task.linkedInspectionRecordIds as Prisma.InputJsonArray,
    linkedServiceOrderRecordIds: task.linkedServiceOrderRecordIds as Prisma.InputJsonArray,
    performerRecordIds: task.performerRecordIds as Prisma.InputJsonArray,
    sourceSnapshot: snapshot as Prisma.InputJsonObject, lastSeenAt: seenAt, active: true,
  };
}

function dateInTimeZone(value: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function addDaysToZonedDate(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
