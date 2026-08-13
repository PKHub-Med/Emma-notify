import { isDeepStrictEqual } from "node:util";
import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import { SyncEntityType, SyncStatus } from "../generated/prisma/enums.js";
import {
  AIRTABLE_TABLE_IDS,
  TASK_FIELD_IDS,
  TASK_FIELDS,
} from "../airtable/field-ids.js";
import { mapTask, type MappedTask } from "../airtable/task.js";
import type {
  AirtableIncrementalSource,
  AirtableRequestMetrics,
} from "../airtable/types.js";
import {
  buildTaskObservation,
  observeCommunication,
  type CommunicationEventStore,
} from "./communication-event.js";

export type TaskSyncMode = "BASELINE" | "INCREMENTAL" | "RECONCILE";
export type TaskUpsertOutcome = "FIRST_SEEN" | "UNCHANGED" | "CHANGED";

export interface TaskSyncStore {
  markRunning(at: Date): Promise<void>;
  getCheckpoint(): Promise<{ baselineCompletedAt: Date | null; lastSuccessfulSyncAt: Date | null } | null>;
  upsertTask(task: MappedTask, seenAt: Date): Promise<TaskUpsertOutcome>;
  markSuccessful(at: Date, ensureBaseline: boolean): Promise<void>;
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
  constructor(private readonly prisma: PrismaClient) {}

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
    return this.prisma.$transaction(async (transaction) => {
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

  async markSuccessful(at: Date, ensureBaseline: boolean): Promise<void> {
    const current = await this.getCheckpoint();
    await this.prisma.syncState.update({
      where: { source_entityType: { source: "AIRTABLE", entityType: SyncEntityType.TASK } },
      data: {
        status: SyncStatus.IDLE,
        lastSuccessfulSyncAt: at,
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
  overlapSeconds?: number;
  requestedMode?: "AUTO" | "RECONCILE";
  now?: () => Date;
  log?: (message: string) => void;
}): Promise<TaskSyncStats> {
  const now = dependencies.now ?? (() => new Date());
  const startedAt = now();
  await dependencies.store.markRunning(startedAt);
  const metricsBefore = requestMetrics(dependencies.airtable);

  try {
    const checkpoint = await dependencies.store.getCheckpoint();
    const communicationBaseline = await dependencies.communicationStore.isBaselineCompleted("TASK");
    const mode: TaskSyncMode = dependencies.requestedMode === "RECONCILE"
      ? "RECONCILE"
      : communicationBaseline ? "INCREMENTAL" : "BASELINE";
    const listOptions = mode === "INCREMENTAL"
      ? { filterByFormula: buildTaskIncrementalFormula(
          new Date((checkpoint?.lastSuccessfulSyncAt ?? startedAt).getTime() -
            (dependencies.overlapSeconds ?? 120) * 1_000),
        ) }
      : undefined;
    const records = await dependencies.airtable.fetchAllRecords(
      AIRTABLE_TABLE_IDS.tasks,
      TASK_FIELD_IDS,
      listOptions,
    );
    const stats: TaskSyncStats = {
      mode, tasksFetched: records.length, recordsFetched: records.length,
      pagesFetched: 0, requestsMade: 0, firstSeen: 0, changed: 0, unchanged: 0,
      durationMs: 0,
    };

    for (const record of records) {
      const detectedAt = now();
      const task = mapTask(record);
      const outcome = await dependencies.store.upsertTask(task, detectedAt);
      if (outcome === "FIRST_SEEN") stats.firstSeen += 1;
      if (outcome === "CHANGED") stats.changed += 1;
      if (outcome === "UNCHANGED") stats.unchanged += 1;
      await observeCommunication({
        store: dependencies.communicationStore,
        observation: buildTaskObservation(task, detectedAt),
        allowEvent: communicationBaseline,
        detectedAt,
        ...(dependencies.log ? { log: dependencies.log } : {}),
      });
    }

    const completedAt = now();
    if (!communicationBaseline) {
      await dependencies.communicationStore.markBaselineCompleted("TASK", completedAt);
    }
    await dependencies.store.markSuccessful(completedAt, true);
    const metricsAfter = requestMetrics(dependencies.airtable);
    stats.pagesFetched = metricsAfter.pagesFetched - metricsBefore.pagesFetched;
    stats.requestsMade = metricsAfter.requestsMade - metricsBefore.requestsMade;
    stats.durationMs = Math.max(0, completedAt.getTime() - startedAt.getTime());
    dependencies.log?.(formatTaskSyncStats(stats));
    return stats;
  } catch (error: unknown) {
    await dependencies.store.markFailed(now());
    throw error;
  }
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
    sourceSnapshot: snapshot as Prisma.InputJsonObject, lastSeenAt: seenAt,
  };
}
