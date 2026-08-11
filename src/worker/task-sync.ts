import { isDeepStrictEqual } from "node:util";
import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import { SyncEntityType, SyncStatus } from "../generated/prisma/enums.js";
import {
  AIRTABLE_TABLE_IDS,
  TASK_FIELD_IDS,
  TASK_FIELDS,
} from "../airtable/field-ids.js";
import { mapTask, type MappedTask } from "../airtable/task.js";
import type { AirtableIncrementalSource } from "../airtable/types.js";
import {
  buildTaskObservation,
  observeCommunication,
  type CommunicationEventStore,
} from "./communication-event.js";

export type TaskUpsertOutcome = "FIRST_SEEN" | "UNCHANGED" | "CHANGED";

export interface TaskSyncStore {
  markRunning(at: Date): Promise<void>;
  getTrackedRecordIds(): Promise<string[]>;
  upsertTask(task: MappedTask, seenAt: Date): Promise<TaskUpsertOutcome>;
  markSuccessful(at: Date): Promise<void>;
  markFailed(at: Date): Promise<void>;
}

export type TaskSyncStats = {
  tasksFetched: number;
  firstSeen: number;
  changed: number;
  unchanged: number;
  durationMs: number;
};

export class PrismaTaskSyncStore implements TaskSyncStore {
  constructor(private readonly prisma: PrismaClient) {}

  async markRunning(at: Date): Promise<void> {
    await this.prisma.syncState.upsert({
      where: {
        source_entityType: {
          source: "AIRTABLE",
          entityType: SyncEntityType.TASK,
        },
      },
      create: {
        source: "AIRTABLE",
        entityType: SyncEntityType.TASK,
        status: SyncStatus.RUNNING,
        lastAttemptAt: at,
      },
      update: {
        status: SyncStatus.RUNNING,
        lastAttemptAt: at,
        lastError: null,
      },
    });
  }

  async upsertTask(task: MappedTask, seenAt: Date): Promise<TaskUpsertOutcome> {
    return this.prisma.$transaction(async (transaction) => {
      const existing = await transaction.trackedTask.findUnique({
        where: { airtableRecordId: task.airtableRecordId },
        select: { sourceSnapshot: true },
      });
      const snapshot = buildTaskSnapshot(task);
      const data = taskData(task, snapshot, seenAt);

      await transaction.trackedTask.upsert({
        where: { airtableRecordId: task.airtableRecordId },
        create: {
          airtableRecordId: task.airtableRecordId,
          ...data,
          firstSeenAt: seenAt,
        },
        update: data,
      });

      if (!existing) return "FIRST_SEEN";
      return isDeepStrictEqual(existing.sourceSnapshot, snapshot)
        ? "UNCHANGED"
        : "CHANGED";
    });
  }

  async getTrackedRecordIds(): Promise<string[]> {
    const tasks = await this.prisma.trackedTask.findMany({
      orderBy: { airtableRecordId: "asc" },
      select: { airtableRecordId: true },
    });
    return tasks.map((task) => task.airtableRecordId);
  }

  async markSuccessful(at: Date): Promise<void> {
    await this.prisma.syncState.update({
      where: {
        source_entityType: {
          source: "AIRTABLE",
          entityType: SyncEntityType.TASK,
        },
      },
      data: {
        status: SyncStatus.IDLE,
        lastSuccessfulSyncAt: at,
        lastError: null,
      },
    });
  }

  async markFailed(at: Date): Promise<void> {
    await this.prisma.syncState.update({
      where: {
        source_entityType: {
          source: "AIRTABLE",
          entityType: SyncEntityType.TASK,
        },
      },
      data: {
        status: SyncStatus.ERROR,
        lastAttemptAt: at,
        lastError: "Task synchronization failed",
      },
    });
  }
}

export async function runTaskSync(dependencies: {
  airtable: AirtableIncrementalSource;
  store: TaskSyncStore;
  communicationStore: CommunicationEventStore;
  now?: () => Date;
  log?: (message: string) => void;
}): Promise<TaskSyncStats> {
  const now = dependencies.now ?? (() => new Date());
  const startedAt = now();
  const stats: TaskSyncStats = {
    tasksFetched: 0,
    firstSeen: 0,
    changed: 0,
    unchanged: 0,
    durationMs: 0,
  };
  await dependencies.store.markRunning(startedAt);

  try {
    const baselineCompleted = await dependencies.communicationStore
      .isBaselineCompleted("TASK");
    const currentRecords = await dependencies.airtable.fetchAllRecords(
      AIRTABLE_TABLE_IDS.tasks,
      TASK_FIELD_IDS,
      { filterByFormula: buildTaskPollingFormula() },
    );
    const recordsById = new Map(
      currentRecords.map((record) => [record.id, record]),
    );
    const trackedRecordIds = await dependencies.store.getTrackedRecordIds();
    for (const recordId of trackedRecordIds) {
      if (recordsById.has(recordId)) continue;
      const record = await dependencies.airtable.fetchRecord(
        AIRTABLE_TABLE_IDS.tasks,
        recordId,
        TASK_FIELD_IDS,
      );
      recordsById.set(record.id, record);
    }
    const records = [...recordsById.values()];
    stats.tasksFetched = records.length;

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
        allowEvent: baselineCompleted,
        detectedAt,
        ...(dependencies.log ? { log: dependencies.log } : {}),
      });
    }

    const completedAt = now();
    stats.durationMs = Math.max(0, completedAt.getTime() - startedAt.getTime());
    await dependencies.store.markSuccessful(completedAt);
    if (!baselineCompleted) {
      await dependencies.communicationStore.markBaselineCompleted(
        "TASK",
        completedAt,
      );
    }
    dependencies.log?.(`[task-sync] completed ${formatStats(stats)}`);
    return stats;
  } catch (error: unknown) {
    await dependencies.store.markFailed(now());
    throw error;
  }
}

export function buildTaskPollingFormula(): string {
  return `NOT({${TASK_FIELDS.emmaMailTemplate}} = '')`;
}

export function buildTaskSnapshot(task: MappedTask) {
  const { airtableRecordId: _airtableRecordId, ...snapshot } = task;
  return snapshot;
}

function taskData(
  task: MappedTask,
  snapshot: ReturnType<typeof buildTaskSnapshot>,
  seenAt: Date,
) {
  return {
    taskNumber: task.taskNumber,
    day: task.day,
    activity: task.activity,
    completed: task.completed,
    status: task.status,
    emmaCustomerStatus: task.emmaCustomerStatus,
    emmaMailTemplate: task.emmaMailTemplate,
    sourceHospitalRecordId: task.sourceHospitalRecordId,
    selectedContactRecordIds:
      task.selectedContactRecordIds as Prisma.InputJsonArray,
    linkedInspectionRecordIds:
      task.linkedInspectionRecordIds as Prisma.InputJsonArray,
    linkedServiceOrderRecordIds:
      task.linkedServiceOrderRecordIds as Prisma.InputJsonArray,
    performerRecordIds: task.performerRecordIds as Prisma.InputJsonArray,
    sourceSnapshot: snapshot as Prisma.InputJsonObject,
    lastSeenAt: seenAt,
  };
}

function formatStats(stats: TaskSyncStats): string {
  return Object.entries(stats)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
}
