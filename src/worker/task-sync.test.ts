import { isDeepStrictEqual } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { TASK_FIELDS } from "../airtable/field-ids.js";
import type { MappedTask } from "../airtable/task.js";
import type {
  AirtableListOptions,
  AirtableRecord,
  AirtableIncrementalSource,
} from "../airtable/types.js";
import {
  createCommunicationFingerprint,
  type CommunicationEventStore,
  type CommunicationObservation,
  type CommunicationObservationResult,
} from "./communication-event.js";
import {
  buildTaskPollingFormula,
  buildTaskSnapshot,
  runTaskSync,
  type TaskSyncStore,
  type TaskUpsertOutcome,
} from "./task-sync.js";

class FakeAirtable implements AirtableIncrementalSource {
  currentRecords: AirtableRecord[] = [];
  readonly recordsById = new Map<string, AirtableRecord>();
  lastOptions: AirtableListOptions | undefined;

  async fetchAllRecords(
    _tableId: string,
    _fieldIds: readonly string[],
    options?: AirtableListOptions,
  ): Promise<AirtableRecord[]> {
    this.lastOptions = options;
    return this.currentRecords;
  }

  async fetchRecord(
    _tableId: string,
    recordId: string,
    _fieldIds: readonly string[],
  ): Promise<AirtableRecord> {
    const record = this.recordsById.get(recordId);
    if (!record) throw new Error(`Missing fake record ${recordId}`);
    return record;
  }

  setCurrent(...records: AirtableRecord[]): void {
    this.currentRecords = records;
    for (const record of records) this.recordsById.set(record.id, record);
  }
}

class MemoryTaskStore implements TaskSyncStore {
  readonly tasks = new Map<string, { task: MappedTask; firstSeenAt: Date }>();

  async markRunning(_at: Date): Promise<void> {}

  async getTrackedRecordIds(): Promise<string[]> {
    return [...this.tasks.keys()];
  }

  async upsertTask(task: MappedTask, seenAt: Date): Promise<TaskUpsertOutcome> {
    const existing = this.tasks.get(task.airtableRecordId);
    this.tasks.set(task.airtableRecordId, {
      task,
      firstSeenAt: existing?.firstSeenAt ?? seenAt,
    });
    if (!existing) return "FIRST_SEEN";
    return isDeepStrictEqual(
      buildTaskSnapshot(existing.task),
      buildTaskSnapshot(task),
    ) ? "UNCHANGED" : "CHANGED";
  }

  async markSuccessful(_at: Date): Promise<void> {}
  async markFailed(_at: Date): Promise<void> {}
}

class MemoryCommunicationStore implements CommunicationEventStore {
  baselineCompleted = false;
  readonly cursors = new Map<string, { signature: string; revision: number }>();
  readonly events: { observation: CommunicationObservation; fingerprint: string }[] = [];
  notificationBufferCalls = 0;
  digestCalls = 0;
  resendCalls = 0;

  async isBaselineCompleted(): Promise<boolean> {
    return this.baselineCompleted;
  }

  async markBaselineCompleted(): Promise<void> {
    this.baselineCompleted = true;
  }

  async observe(
    observation: CommunicationObservation,
    allowEvent: boolean,
    _detectedAt: Date,
  ): Promise<CommunicationObservationResult> {
    const key = `${observation.sourceEntityType}:${observation.sourceRecordId}`;
    const cursor = this.cursors.get(key);
    if (cursor?.signature === observation.signature) {
      return { outcome: "UNCHANGED", revision: cursor.revision };
    }
    const revision = cursor ? cursor.revision + 1 : 0;
    this.cursors.set(key, { signature: observation.signature, revision });
    if (!observation.scenario) return { outcome: "NO_SCENARIO", revision };
    if (!allowEvent) return { outcome: "SUPPRESSED", revision };
    const fingerprint = createCommunicationFingerprint(observation, revision);
    if (!this.events.some((event) => event.fingerprint === fingerprint)) {
      this.events.push({ observation, fingerprint });
    }
    return { outcome: "CREATED", revision, fingerprint };
  }
}

describe("task polling and communication events", () => {
  it("stores existing tasks during the first baseline without events", async () => {
    const fixture = taskFixture();
    fixture.source.setCurrent(taskRecord());

    const stats = await fixture.run();

    expect(fixture.source.lastOptions?.filterByFormula).toBe(
      buildTaskPollingFormula(),
    );
    expect(stats).toMatchObject({ tasksFetched: 1, firstSeen: 1 });
    expect(fixture.communication.baselineCompleted).toBe(true);
    expect(fixture.communication.events).toHaveLength(0);
  });

  it("does not replay baseline records after restart or 100 identical polls", async () => {
    const fixture = taskFixture();
    fixture.source.setCurrent(taskRecord());
    await fixture.run();

    for (let poll = 0; poll < 100; poll += 1) await fixture.run();

    expect(fixture.store.tasks.size).toBe(1);
    expect(fixture.communication.events).toHaveLength(0);
  });

  it("creates an event for a new task first seen after baseline", async () => {
    const fixture = taskFixture();
    fixture.communication.baselineCompleted = true;
    fixture.source.setCurrent(taskRecord());

    await fixture.run();

    expect(fixture.communication.events).toHaveLength(1);
    expect(fixture.communication.events[0]?.observation.scenario).toBe(
      "INSPECTION_DATE_CONFIRMED",
    );
  });

  it("keeps exactly one event across 100 identical post-baseline polls", async () => {
    const fixture = taskFixture();
    fixture.communication.baselineCompleted = true;
    fixture.source.setCurrent(taskRecord());

    for (let poll = 0; poll < 100; poll += 1) await fixture.run();

    expect(fixture.communication.events).toHaveLength(1);
  });

  it("creates a second confirmed-date event when day changes", async () => {
    const fixture = taskFixture();
    fixture.communication.baselineCompleted = true;
    fixture.source.setCurrent(taskRecord({ [TASK_FIELDS.day]: "2026-09-10" }));
    await fixture.run();
    fixture.source.setCurrent(taskRecord({ [TASK_FIELDS.day]: "2026-09-11" }));

    await fixture.run();

    expect(fixture.communication.events).toHaveLength(2);
    expect(fixture.communication.events.map((event) =>
      event.observation.eventSnapshot.day)).toEqual([
      "2026-09-10",
      "2026-09-11",
    ]);
  });

  it("does not create an event for an irrelevant activity change", async () => {
    const fixture = taskFixture();
    fixture.communication.baselineCompleted = true;
    fixture.source.setCurrent(taskRecord());
    await fixture.run();
    fixture.source.setCurrent(taskRecord({
      [TASK_FIELDS.activity]: "Techniczna zmiana opisu",
    }));

    await fixture.run();

    expect(fixture.communication.events).toHaveLength(1);
  });

  it("observes template A to blank to A as a new communication cycle", async () => {
    const fixture = taskFixture();
    fixture.communication.baselineCompleted = true;
    const active = taskRecord();
    fixture.source.setCurrent(active);
    await fixture.run();

    const blank = taskRecord({
      [TASK_FIELDS.emmaCustomerStatus]: "",
      [TASK_FIELDS.emmaMailTemplate]: "",
    });
    fixture.source.currentRecords = [];
    fixture.source.recordsById.set(blank.id, blank);
    await fixture.run();

    fixture.source.setCurrent(active);
    await fixture.run();

    expect(fixture.communication.events).toHaveLength(2);
    expect(fixture.communication.events[0]?.fingerprint).not.toBe(
      fixture.communication.events[1]?.fingerprint,
    );
  });

  it("never invokes buffers, digests or Resend", async () => {
    const fixture = taskFixture();
    fixture.communication.baselineCompleted = true;
    fixture.source.setCurrent(taskRecord());

    await fixture.run();

    expect(fixture.communication).toMatchObject({
      notificationBufferCalls: 0,
      digestCalls: 0,
      resendCalls: 0,
    });
  });

  it("marks a failed synchronization without creating an event", async () => {
    const fixture = taskFixture();
    const markFailed = vi.spyOn(fixture.store, "markFailed");
    vi.spyOn(fixture.source, "fetchAllRecords")
      .mockRejectedValueOnce(new Error("offline"));

    await expect(fixture.run()).rejects.toThrow("offline");
    expect(markFailed).toHaveBeenCalledOnce();
    expect(fixture.communication.events).toHaveLength(0);
  });
});

function taskFixture() {
  const source = new FakeAirtable();
  const store = new MemoryTaskStore();
  const communication = new MemoryCommunicationStore();
  return {
    source,
    store,
    communication,
    run: () => runTaskSync({
      airtable: source,
      store,
      communicationStore: communication,
      now: () => new Date("2026-08-11T10:00:00.000Z"),
    }),
  };
}

function taskRecord(overrides: Record<string, unknown> = {}): AirtableRecord {
  return {
    id: "recTask",
    createdTime: "2026-08-11T08:00:00.000Z",
    fields: {
      [TASK_FIELDS.sequenceNumber]: 12,
      [TASK_FIELDS.day]: "2026-09-10",
      [TASK_FIELDS.activity]: "Potwierdzenie terminu",
      [TASK_FIELDS.completed]: false,
      [TASK_FIELDS.status]: "Zaplanowane",
      [TASK_FIELDS.emmaCustomerStatus]: "Ustalono termin wizyty",
      [TASK_FIELDS.emmaMailTemplate]:
        "Przegląd-informacja_o_umówionej_wizycie",
      [TASK_FIELDS.selectedContactLinks]: ["recContactA", "recContactB"],
      [TASK_FIELDS.inspectionLinks]: ["recInspectionA", "recInspectionB"],
      [TASK_FIELDS.serviceOrderLinks]: ["recServiceA"],
      [TASK_FIELDS.assigneeLinks]: ["recEmployeeA", "recEmployeeB"],
      ...overrides,
    },
  };
}
