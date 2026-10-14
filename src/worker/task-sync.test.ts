import { isDeepStrictEqual } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { INSPECTION_FIELDS, TASK_FIELDS } from "../airtable/field-ids.js";
import type { MappedTask } from "../airtable/task.js";
import {
  CommunicationDiagnosticStatus,
  CommunicationDeliveryStatus,
  CommunicationScenario,
} from "../generated/prisma/enums.js";
import type {
  CommunicationCycleSummary,
  CommunicationDiagnosticRegistry,
  CompletedDataReadiness,
  DiagnosticTransition,
} from "./communication-diagnostics.js";
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
  runCommunicationDeliveryPlanner,
  type CommunicationDeliveryStore,
  type DeliveryPlan,
  type DeliveryPlanningEvent,
  type PlannedDelivery,
} from "./communication-delivery.js";
import {
  buildTaskPollingFormula,
  buildTaskIncrementalFormula,
  buildReminderEligibilityFormula,
  TASK_EDITABLE_FIELD_IDS,
  buildTaskSnapshot,
  COMPLETED_COMMUNICATIONS_PER_RUN_LIMIT,
  runTaskSync,
  type TaskSyncStore,
  type TaskUpsertOutcome,
} from "./task-sync.js";

class FakeAirtable implements AirtableIncrementalSource {
  currentRecords: AirtableRecord[] = [];
  readonly recordsById = new Map<string, AirtableRecord>();
  lastOptions: AirtableListOptions | undefined;
  lastFieldIds: readonly string[] = [];

  async fetchAllRecords(
    _tableId: string,
    fieldIds: readonly string[],
    options?: AirtableListOptions,
  ): Promise<AirtableRecord[]> {
    this.lastFieldIds = fieldIds;
    this.lastOptions = options;
    if (options?.filterByFormula?.includes("Przegląd-przypomnienie_o_wizycie")) {
      const tomorrow = options.filterByFormula.match(/= '(\d{4}-\d{2}-\d{2})'/)?.[1];
      return this.currentRecords.filter((record) =>
        record.fields[TASK_FIELDS.day] === tomorrow &&
        record.fields[TASK_FIELDS.emmaMailTemplate] ===
          "Przegląd-przypomnienie_o_wizycie" &&
        record.fields[TASK_FIELDS.emmaCustomerStatus] === "Przypomnienie o wizycie"
      );
    }
    return this.currentRecords;
  }

  async fetchAllRecordsWithMetrics(
    tableId: string,
    fieldIds: readonly string[],
    options?: AirtableListOptions,
  ) {
    return {
      records: await this.fetchAllRecords(tableId, fieldIds, options),
      metrics: { pagesFetched: 1, requestsMade: 1 },
    };
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
  checkpoint: { baselineCompletedAt: Date | null; lastSuccessfulSyncAt: Date | null } | null = null;

  async markRunning(_at: Date): Promise<void> {}

  async getCheckpoint() { return this.checkpoint; }

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

  async markSuccessful(
    at: Date,
    ensureBaseline: boolean,
    advanceCursor: boolean,
  ): Promise<void> {
    this.checkpoint = {
      baselineCompletedAt: this.checkpoint?.baselineCompletedAt ?? (ensureBaseline ? at : null),
      lastSuccessfulSyncAt: advanceCursor
        ? at
        : this.checkpoint?.lastSuccessfulSyncAt ?? null,
    };
  }
  async markFailed(_at: Date): Promise<void> {}
}

class MemoryCommunicationStore implements CommunicationEventStore {
  baselineCompleted = false;
  readonly cursors = new Map<string, {
    signature: string;
    revision: number;
    lastEventRevision: number | null;
    pendingEventRevision: number | null;
  }>();
  readonly events: { id: string; observation: CommunicationObservation; fingerprint: string }[] = [];
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
    retryableSuppression = false,
  ): Promise<CommunicationObservationResult> {
    const key = `${observation.sourceEntityType}:${observation.sourceRecordId}`;
    const cursor = this.cursors.get(key);
    if (cursor?.signature === observation.signature) {
      if (!observation.scenario) return { outcome: "NO_SCENARIO", revision: cursor.revision };
      if (cursor.lastEventRevision === cursor.revision) {
        cursor.pendingEventRevision = null;
        return { outcome: "UNCHANGED", revision: cursor.revision };
      }
      if (!allowEvent) {
        cursor.pendingEventRevision = retryableSuppression ? cursor.revision : null;
        return { outcome: "SUPPRESSED", revision: cursor.revision };
      }
      if (cursor.pendingEventRevision !== cursor.revision) {
        return { outcome: "UNCHANGED", revision: cursor.revision };
      }
      const fingerprint = createCommunicationFingerprint(observation, cursor.revision);
      const id = `event-${this.events.length + 1}`;
      this.events.push({ id, observation, fingerprint });
      cursor.lastEventRevision = cursor.revision;
      cursor.pendingEventRevision = null;
      return { outcome: "CREATED", revision: cursor.revision, fingerprint, eventId: id };
    }
    const revision = cursor ? cursor.revision + 1 : 0;
    this.cursors.set(key, {
      signature: observation.signature,
      revision,
      // The Prisma update keeps the last handled revision as historical
      // evidence when the cursor advances to a newer signature.
      lastEventRevision: cursor?.lastEventRevision ?? null,
      pendingEventRevision: retryableSuppression && !allowEvent ? revision : null,
    });
    if (!observation.scenario) return { outcome: "NO_SCENARIO", revision };
    if (!allowEvent) return { outcome: "SUPPRESSED", revision };
    const fingerprint = createCommunicationFingerprint(observation, revision);
    const id = `event-${this.events.length + 1}`;
    if (!this.events.some((event) => event.fingerprint === fingerprint)) {
      this.events.push({ id, observation, fingerprint });
    }
    this.cursors.get(key)!.lastEventRevision = revision;
    this.cursors.get(key)!.pendingEventRevision = null;
    return { outcome: "CREATED", revision, fingerprint, eventId: id };
  }
}

class MemoryDiagnostics implements CommunicationDiagnosticRegistry {
  readiness: CompletedDataReadiness = { ready: false, reasonCode: "INSPECTION_RESULTS_INCOMPLETE",
    missingData: { expectedInspectionIds: ["recInspectionA", "recInspectionB"] } };
  transitions: DiagnosticTransition[] = [];

  async record(input: DiagnosticTransition): Promise<boolean> {
    this.transitions.push(input);
    return true;
  }
  async assessCompletedData(): Promise<CompletedDataReadiness> { return this.readiness; }
  async findDuePendingTasks(): Promise<Array<{
    sourceRecordId: string;
    firstDetectedAt: Date;
    expiresAt: Date | null;
    reasonCode: string;
    missingData: Record<string, unknown> | null;
  }>> {
    const latest = this.transitions.at(-1);
    if (latest?.status !== CommunicationDiagnosticStatus.PENDING_DATA) return [];
    const first = this.transitions.find((item) =>
      item.status === CommunicationDiagnosticStatus.PENDING_DATA) ?? latest;
    return [{
      sourceRecordId: latest.sourceRecordId,
      firstDetectedAt: first.checkedAt,
      expiresAt: latest.expiresAt ?? null,
      reasonCode: latest.reasonCode,
      missingData: latest.missingData ?? null,
    }];
  }
  async wakePendingForInspection(): Promise<number> { return 0; }
  async synchronizeDelivery(): Promise<void> {}
  async summarizeCycle(): Promise<CommunicationCycleSummary> {
    return { checked: this.transitions.length, pending: 0, blocked: 0,
      eventsCreated: 0, sent: 0, cancelled: 0, interventionRequired: 0 };
  }
}

class ReminderPipelineDeliveryStore implements CommunicationDeliveryStore {
  readonly deliveries: PlannedDelivery[] = [];
  private processed = false;

  constructor(private readonly event: DeliveryPlanningEvent) {}

  async findEventsAwaitingDelivery() {
    return this.processed ? [] : [this.event];
  }

  async ensureDeliveries(
    event: DeliveryPlanningEvent,
    plans: readonly DeliveryPlan[],
  ) {
    const created = plans.map((plan, index) => ({
      ...plan,
      id: `delivery-${index}`,
      eventId: event.id,
      scenario: event.scenario,
    }));
    this.deliveries.push(...created);
    this.processed = true;
    return created;
  }

  async findDueReminders() { return []; }
  async getCurrentTask() { return null; }
  async transitionReminder() { return false; }
}

describe("task polling and communication events", () => {
  it("stores existing tasks during the first baseline without events", async () => {
    const fixture = taskFixture();
    fixture.source.setCurrent(taskRecord());

    const stats = await fixture.run();

    expect(fixture.source.lastOptions).toBeUndefined();
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
    expect(fixture.source.lastOptions?.filterByFormula).toContain("LAST_MODIFIED_TIME");
  });

  it("fetches zero records on an identical incremental poll", async () => {
    const fixture = taskFixture();
    const upsertTask = vi.spyOn(fixture.store, "upsertTask");
    const observe = vi.spyOn(fixture.communication, "observe");
    const markSuccessful = vi.spyOn(fixture.store, "markSuccessful");
    const markFailed = vi.spyOn(fixture.store, "markFailed");
    fixture.source.setCurrent(taskRecord());
    const baseline = await fixture.run();
    const cursorBeforeEmptyPoll = fixture.communication.cursors.get("TASK:recTask");
    upsertTask.mockClear();
    observe.mockClear();
    markSuccessful.mockClear();
    fixture.source.setCurrent();
    const logs: string[] = [];
    const incremental = await runTaskSync({
      airtable: fixture.source,
      store: fixture.store,
      communicationStore: fixture.communication,
      now: () => new Date("2026-08-11T10:05:00.000Z"),
      log: (message) => logs.push(message),
    });
    expect(baseline).toMatchObject({ mode: "BASELINE", recordsFetched: 1 });
    expect(incremental).toMatchObject({
      mode: "INCREMENTAL", recordsFetched: 0, pagesFetched: 1, requestsMade: 1,
    });
    expect(upsertTask).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
    expect(fixture.communication.cursors.size).toBe(1);
    expect(fixture.communication.cursors.get("TASK:recTask")).toEqual(
      cursorBeforeEmptyPoll,
    );
    expect(markSuccessful).toHaveBeenCalledWith(
      new Date("2026-08-11T10:05:00.000Z"),
      false,
      true,
    );
    expect(fixture.store.checkpoint?.lastSuccessfulSyncAt?.toISOString()).toBe(
      "2026-08-11T10:05:00.000Z",
    );
    expect(markFailed).not.toHaveBeenCalled();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain(
      "recordsFetched=0 pagesFetched=1 requestsMade=1",
    );
    expect(logs[0]).not.toContain("PrismaClientValidationError");
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

  it.each([
    ["INSPECTION_DATE_CONFIRMED", "2026-10-11"],
    ["INSPECTION_DATE_PROPOSED", "2026-10-11"],
  ] as const)("allows %s when the visit is today in Warsaw", async (scenario, day) => {
    const fixture = taskFixture();
    fixture.communication.baselineCompleted = true;
    fixture.source.setCurrent(inspectionDateTaskRecord(scenario, day));

    await runTaskSync({
      airtable: fixture.source,
      store: fixture.store,
      communicationStore: fixture.communication,
      timeZone: "Europe/Warsaw",
      now: () => new Date("2026-10-10T22:30:00.000Z"),
    });

    expect(fixture.communication.events).toHaveLength(1);
    expect(fixture.communication.events[0]?.observation.scenario).toBe(scenario);
    expect(fixture.communication.events[0]?.observation.eventSnapshot.day).toBe(day);
  });

  it.each([
    ["INSPECTION_DATE_CONFIRMED", "2026-10-12"],
    ["INSPECTION_DATE_PROPOSED", "2026-10-20"],
  ] as const)("keeps future %s eligible", async (scenario, day) => {
    const fixture = taskFixture();
    fixture.communication.baselineCompleted = true;
    fixture.source.setCurrent(inspectionDateTaskRecord(scenario, day));

    await runTaskSync({
      airtable: fixture.source,
      store: fixture.store,
      communicationStore: fixture.communication,
      timeZone: "Europe/Warsaw",
      now: () => new Date("2026-10-11T10:00:00.000Z"),
    });

    expect(fixture.communication.events).toHaveLength(1);
    expect(fixture.communication.events[0]?.observation.scenario).toBe(scenario);
  });

  it.each([
    "INSPECTION_DATE_CONFIRMED",
    "INSPECTION_DATE_PROPOSED",
  ] as const)("does not extend %s eligibility into the past", async (scenario) => {
    const fixture = taskFixture();
    fixture.communication.baselineCompleted = true;
    fixture.source.setCurrent(inspectionDateTaskRecord(scenario, "2026-10-10"));

    await runTaskSync({
      airtable: fixture.source,
      store: fixture.store,
      communicationStore: fixture.communication,
      timeZone: "Europe/Warsaw",
      now: () => new Date("2026-10-11T10:00:00.000Z"),
    });

    expect(fixture.communication.events).toHaveLength(0);
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
    fixture.source.setCurrent(blank);
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

  it("observes only confirmed editable fields in LAST_MODIFIED_TIME", () => {
    const formula = buildTaskIncrementalFormula(new Date("2026-08-11T09:58:00Z"));
    for (const fieldId of TASK_EDITABLE_FIELD_IDS) expect(formula).toContain(`{${fieldId}}`);
    expect(formula).not.toContain(`{${TASK_FIELDS.emmaCustomerStatus}}`);
    expect(formula).not.toContain(`{${TASK_FIELDS.emmaMailTemplate}}`);
    expect(buildTaskPollingFormula()).toContain("LAST_MODIFIED_TIME");
  });

  it("requests EMMA: mail DT during task synchronization", async () => {
    const fixture = taskFixture();
    fixture.source.setCurrent(taskRecord());

    await fixture.run();

    expect(fixture.source.lastFieldIds).toContain(TASK_FIELDS.emmaRecipientEmail);
  });

  it("runs an explicit reconcile without an incremental filter", async () => {
    const fixture = taskFixture();
    fixture.communication.baselineCompleted = true;
    fixture.source.setCurrent(taskRecord());
    const stats = await runTaskSync({
      airtable: fixture.source,
      store: fixture.store,
      communicationStore: fixture.communication,
      requestedMode: "RECONCILE",
      now: () => new Date("2026-08-11T10:00:00.000Z"),
    });
    expect(stats.mode).toBe("RECONCILE");
    expect(fixture.source.lastOptions).toBeUndefined();
  });

  it("suppresses historical 2025/2026 completed tasks during 28.09.2026 reconcile", async () => {
    const fixture = taskFixture();
    fixture.communication.baselineCompleted = true;
    fixture.source.setCurrent(
      completedTaskRecord("rec2025", "2025-10-06"),
      completedTaskRecord("rec2026", "2026-04-08"),
    );

    await runTaskSync({
      airtable: fixture.source,
      store: fixture.store,
      communicationStore: fixture.communication,
      requestedMode: "RECONCILE",
      timeZone: "Europe/Warsaw",
      now: () => new Date("2026-09-28T04:30:00.000Z"),
    });

    expect(fixture.communication.events).toHaveLength(0);
    expect(fixture.communication.resendCalls).toBe(0);
    expect(fixture.communication.cursors.size).toBe(2);
  });

  it("updates a changed communication cursor during reconcile without creating an event", async () => {
    const fixture = taskFixture();
    fixture.communication.baselineCompleted = true;
    fixture.communication.cursors.set("TASK:recTask", { signature: "old-contract", revision: 4 });
    fixture.source.setCurrent(completedTaskRecord("recTask", "2025-11-25"));

    await runTaskSync({
      airtable: fixture.source,
      store: fixture.store,
      communicationStore: fixture.communication,
      requestedMode: "RECONCILE",
      now: () => new Date("2026-09-28T04:30:00.000Z"),
    });

    expect(fixture.communication.events).toHaveLength(0);
    expect(fixture.communication.cursors.get("TASK:recTask")).toMatchObject({ revision: 5 });
    expect(fixture.communication.cursors.get("TASK:recTask")?.signature).not.toBe("old-contract");
  });

  it("21271: preserves revision 4 seen by reconcile and emits it once in incremental", async () => {
    const fixture = taskFixture();
    const diagnostics = new MemoryDiagnostics();
    diagnostics.readiness = { ready: true };
    fixture.communication.baselineCompleted = true;
    fixture.store.checkpoint = {
      baselineCompletedAt: new Date("2026-10-01T00:00:00Z"),
      lastSuccessfulSyncAt: new Date("2026-10-12T07:00:00Z"),
    };
    fixture.communication.cursors.set("TASK:rec21271", {
      signature: "revision-3-before-completion",
      revision: 3,
      lastEventRevision: 2,
      pendingEventRevision: null,
    });
    fixture.source.setCurrent(completedTaskRecord("rec21271", "2026-10-12"));
    const common = {
      airtable: fixture.source,
      store: fixture.store,
      communicationStore: fixture.communication,
      diagnostics,
      timeZone: "Europe/Warsaw",
      now: () => new Date("2026-10-12T08:00:00Z"),
    };

    await runTaskSync({ ...common, requestedMode: "RECONCILE" });

    expect(fixture.communication.events).toHaveLength(0);
    expect(fixture.communication.cursors.get("TASK:rec21271")).toMatchObject({
      revision: 4,
      lastEventRevision: 2,
      pendingEventRevision: 4,
    });
    expect(fixture.store.checkpoint.lastSuccessfulSyncAt?.toISOString())
      .toBe("2026-10-12T07:00:00.000Z");
    expect(diagnostics.transitions.at(-1)).toMatchObject({
      status: CommunicationDiagnosticStatus.PENDING_DATA,
      reasonCode: "RECONCILE_DEFERRED",
    });

    // Model a record absent from LAST_MODIFIED_TIME: the persisted diagnostic
    // must force an exact refetch by ID on the next incremental cycle.
    fixture.source.currentRecords = [];
    await runTaskSync(common);
    await runTaskSync(common);

    expect(fixture.communication.events).toHaveLength(1);
    expect(fixture.communication.cursors.get("TASK:rec21271")).toMatchObject({
      revision: 4,
      lastEventRevision: 4,
      pendingEventRevision: null,
    });
  });

  it("21272: reconcile does not consume an incomplete incremental completion", async () => {
    const fixture = taskFixture();
    const diagnostics = new MemoryDiagnostics();
    fixture.communication.baselineCompleted = true;
    fixture.communication.cursors.set("TASK:rec21272", {
      signature: "revision-3-before-completion",
      revision: 3,
      lastEventRevision: 2,
      pendingEventRevision: null,
    });
    fixture.source.setCurrent(completedTaskRecord("rec21272", "2026-10-12"));
    const common = {
      airtable: fixture.source,
      store: fixture.store,
      communicationStore: fixture.communication,
      diagnostics,
      timeZone: "Europe/Warsaw",
      now: () => new Date("2026-10-12T08:00:00Z"),
    };

    await runTaskSync(common);
    expect(fixture.communication.cursors.get("TASK:rec21272")?.pendingEventRevision).toBe(4);
    await runTaskSync({ ...common, requestedMode: "RECONCILE" });
    expect(fixture.communication.cursors.get("TASK:rec21272")?.pendingEventRevision).toBe(4);
    expect(diagnostics.transitions.at(-1)).toMatchObject({
      status: CommunicationDiagnosticStatus.PENDING_DATA,
      reasonCode: "INSPECTION_RESULTS_INCOMPLETE",
      missingData: { expectedInspectionIds: ["recInspectionA", "recInspectionB"] },
    });

    diagnostics.readiness = { ready: true };
    await runTaskSync(common);
    expect(fixture.communication.events).toHaveLength(1);
    expect(fixture.communication.cursors.get("TASK:rec21272")).toMatchObject({
      revision: 4,
      lastEventRevision: 4,
      pendingEventRevision: null,
    });
  });

  it("21282: reconcile and incremental do not replay an already handled revision", async () => {
    const fixture = taskFixture();
    const diagnostics = new MemoryDiagnostics();
    diagnostics.readiness = { ready: true };
    fixture.communication.baselineCompleted = true;
    fixture.source.setCurrent(completedTaskRecord("rec21282", "2026-10-12"));
    const common = {
      airtable: fixture.source,
      store: fixture.store,
      communicationStore: fixture.communication,
      diagnostics,
      timeZone: "Europe/Warsaw",
      now: () => new Date("2026-10-12T08:00:00Z"),
    };

    await runTaskSync(common);
    const sentCursor = fixture.communication.cursors.get("TASK:rec21282")!;
    sentCursor.revision = 2;
    sentCursor.lastEventRevision = 2;
    await runTaskSync({ ...common, requestedMode: "RECONCILE" });
    await runTaskSync(common);

    expect(fixture.communication.events).toHaveLength(1);
    expect(fixture.communication.cursors.get("TASK:rec21282")).toMatchObject({
      revision: 2,
      lastEventRevision: 2,
      pendingEventRevision: null,
    });
  });

  it("21310: repeatedly reconciling revision 1 keeps one pending revision", async () => {
    const fixture = taskFixture();
    const diagnostics = new MemoryDiagnostics();
    diagnostics.readiness = { ready: true };
    fixture.communication.baselineCompleted = true;
    fixture.communication.cursors.set("TASK:rec21310", {
      signature: "revision-0-before-completion",
      revision: 0,
      lastEventRevision: null,
      pendingEventRevision: null,
    });
    fixture.source.setCurrent(completedTaskRecord("rec21310", "2026-10-12"));
    const common = {
      airtable: fixture.source,
      store: fixture.store,
      communicationStore: fixture.communication,
      diagnostics,
      requestedMode: "RECONCILE" as const,
      timeZone: "Europe/Warsaw",
      now: () => new Date("2026-10-12T08:00:00Z"),
    };

    await runTaskSync(common);
    await runTaskSync(common);
    await runTaskSync(common);

    expect(fixture.communication.events).toHaveLength(0);
    expect(fixture.communication.cursors.get("TASK:rec21310")).toMatchObject({
      revision: 1,
      lastEventRevision: null,
      pendingEventRevision: 1,
    });
  });

  it("21263: a later linked inspection result does not create a second summary", async () => {
    const fixture = taskFixture();
    const diagnostics = new MemoryDiagnostics();
    diagnostics.readiness = { ready: true };
    fixture.communication.baselineCompleted = true;
    fixture.source.setCurrent(completedTaskRecord("rec21263", "2026-10-12"));
    const common = {
      airtable: fixture.source,
      store: fixture.store,
      communicationStore: fixture.communication,
      diagnostics,
      timeZone: "Europe/Warsaw",
      now: () => new Date("2026-10-12T08:00:00Z"),
    };

    await runTaskSync(common);
    const handledCursor = fixture.communication.cursors.get("TASK:rec21263")!;
    handledCursor.revision = 4;
    handledCursor.lastEventRevision = 4;
    const completedWithAdditionalInspection = completedTaskRecord("rec21263", "2026-10-12");
    completedWithAdditionalInspection.fields[TASK_FIELDS.inspectionLinks] = [
      "recInspectionA", "recInspectionB", "recInspectionAddedLater",
    ];
    fixture.source.setCurrent(completedWithAdditionalInspection);
    await runTaskSync(common);

    expect(fixture.communication.events).toHaveLength(1);
    expect(fixture.communication.cursors.get("TASK:rec21263")).toMatchObject({
      revision: 4,
      lastEventRevision: 4,
      pendingEventRevision: null,
    });
  });

  it("creates one current completed event during incremental sync and none on rerun", async () => {
    const fixture = taskFixture();
    fixture.communication.baselineCompleted = true;
    fixture.source.setCurrent(completedTaskRecord("recTask", "2026-09-28"));
    const input = {
      airtable: fixture.source,
      store: fixture.store,
      communicationStore: fixture.communication,
      timeZone: "Europe/Warsaw",
      now: () => new Date("2026-09-28T04:30:00.000Z"),
    };

    await runTaskSync(input);
    await runTaskSync(input);

    expect(fixture.communication.events).toHaveLength(1);
    expect(fixture.communication.events[0]?.observation.scenario).toBe("INSPECTION_COMPLETED");
  });

  it("in test mode uses performedAt instead of a later planned task day", async () => {
    const fixture = taskFixture();
    fixture.communication.baselineCompleted = true;
    fixture.source.setCurrent(completedTaskRecord("recTask", "2026-10-15"));
    fixture.source.recordsById.set("recInspectionA", inspectionRecord(
      "recInspectionA",
      "2026-10-10T08:30:00.000Z",
    ));
    fixture.source.recordsById.set("recInspectionB", inspectionRecord(
      "recInspectionB",
      "2026-10-10T09:00:00.000Z",
    ));

    await runTaskSync({
      airtable: fixture.source,
      store: fixture.store,
      communicationStore: fixture.communication,
      mailTestMode: true,
      timeZone: "Europe/Warsaw",
      now: () => new Date("2026-10-10T10:00:00.000Z"),
    });

    expect(fixture.communication.events).toHaveLength(1);
    expect(fixture.communication.events[0]?.observation.scenario)
      .toBe("INSPECTION_COMPLETED");
  });

  it("in test mode does not create completed events from historical performedAt", async () => {
    const fixture = taskFixture();
    fixture.communication.baselineCompleted = true;
    fixture.source.setCurrent(completedTaskRecord("recTask", "2026-10-10"));
    fixture.source.recordsById.set("recInspectionA", inspectionRecord(
      "recInspectionA",
      "2026-10-09T08:30:00.000Z",
    ));
    fixture.source.recordsById.set("recInspectionB", inspectionRecord(
      "recInspectionB",
      "2026-10-09T09:00:00.000Z",
    ));

    await runTaskSync({
      airtable: fixture.source,
      store: fixture.store,
      communicationStore: fixture.communication,
      mailTestMode: true,
      timeZone: "Europe/Warsaw",
      now: () => new Date("2026-10-10T10:00:00.000Z"),
    });

    expect(fixture.communication.events).toHaveLength(0);
  });

  it("opens the completed circuit breaker at 20 events and suppresses the rest", async () => {
    const fixture = taskFixture();
    const logs: string[] = [];
    fixture.communication.baselineCompleted = true;
    fixture.source.setCurrent(...Array.from({ length: 30 }, (_, index) =>
      completedTaskRecord(`recCompleted${index}`, "2026-09-28")));

    await runTaskSync({
      airtable: fixture.source,
      store: fixture.store,
      communicationStore: fixture.communication,
      timeZone: "Europe/Warsaw",
      now: () => new Date("2026-09-28T04:30:00.000Z"),
      log: (message) => logs.push(message),
    });

    expect(fixture.communication.events).toHaveLength(COMPLETED_COMMUNICATIONS_PER_RUN_LIMIT);
    expect(fixture.communication.cursors.size).toBe(30);
    expect(logs).toContain(
      `ERROR COMMUNICATION_COMPLETED_SAFETY_LIMIT_REACHED ` +
      `limit=${COMPLETED_COMMUNICATIONS_PER_RUN_LIMIT} mode=INCREMENTAL`,
    );
  });

  it("builds a narrow reminder eligibility formula for tomorrow in Warsaw", () => {
    const formula = buildReminderEligibilityFormula(
      new Date("2026-08-13T22:30:00.000Z"),
      "Europe/Warsaw",
    );
    expect(formula).toBe(
      `AND(DATETIME_FORMAT(SET_TIMEZONE({${TASK_FIELDS.day}}, 'Europe/Warsaw'), 'YYYY-MM-DD') = '2026-08-15', {${TASK_FIELDS.emmaMailTemplate}} = 'Przegląd-przypomnienie_o_wizycie', {${TASK_FIELDS.emmaCustomerStatus}} = 'Przypomnienie o wizycie')`,
    );
    expect(formula).not.toContain("2026-08-14'");
    expect(formula).not.toContain("2026-08-16");
  });

  it("creates one reminder event when tomorrow becomes eligible", async () => {
    const fixture = taskFixture();
    fixture.communication.baselineCompleted = true;
    fixture.store.checkpoint = {
      baselineCompletedAt: new Date("2026-08-01T00:00:00Z"),
      lastSuccessfulSyncAt: new Date("2026-08-13T04:00:00Z"),
    };
    fixture.source.setCurrent(taskRecord({
      [TASK_FIELDS.day]: "2026-08-15",
      [TASK_FIELDS.emmaCustomerStatus]: "Przypomnienie o wizycie",
      [TASK_FIELDS.emmaMailTemplate]: "Przegląd-przypomnienie_o_wizycie",
    }));
    const stats = await runTaskSync({
      airtable: fixture.source,
      store: fixture.store,
      communicationStore: fixture.communication,
      requestedMode: "REMINDER_ELIGIBILITY",
      timeZone: "Europe/Warsaw",
      now: () => new Date("2026-08-14T04:30:00Z"),
    });
    expect(stats).toMatchObject({ mode: "REMINDER_ELIGIBILITY", recordsFetched: 1 });
    expect(fixture.source.lastOptions?.filterByFormula).toContain("'2026-08-15'");
    expect(fixture.store.checkpoint.lastSuccessfulSyncAt?.toISOString()).toBe(
      "2026-08-13T04:00:00.000Z",
    );
    expect(fixture.communication.events).toHaveLength(1);
    expect(fixture.communication.events[0]?.observation.scenario).toBe(
      "INSPECTION_REMINDER",
    );
  });

  it("does not fetch today, day-after-tomorrow or wrong-template tasks", async () => {
    const fixture = taskFixture();
    fixture.communication.baselineCompleted = true;
    fixture.source.setCurrent(
      taskRecord({ [TASK_FIELDS.day]: "2026-08-14" }),
      { ...taskRecord({ [TASK_FIELDS.day]: "2026-08-16" }), id: "recDayAfter" },
      { ...taskRecord({
        [TASK_FIELDS.day]: "2026-08-15",
        [TASK_FIELDS.emmaCustomerStatus]: "Przypomnienie o wizycie",
        [TASK_FIELDS.emmaMailTemplate]: "Inny szablon",
      }), id: "recWrongTemplate" },
      { ...taskRecord({
        [TASK_FIELDS.day]: "2026-08-15",
        [TASK_FIELDS.emmaCustomerStatus]: "Inny status",
        [TASK_FIELDS.emmaMailTemplate]: "Przegląd-przypomnienie_o_wizycie",
      }), id: "recWrongStatus" },
    );
    const stats = await runTaskSync({
      airtable: fixture.source,
      store: fixture.store,
      communicationStore: fixture.communication,
      requestedMode: "REMINDER_ELIGIBILITY",
      now: () => new Date("2026-08-14T04:30:00Z"),
    });
    expect(stats.recordsFetched).toBe(0);
    expect(fixture.communication.events).toHaveLength(0);
  });

  it("keeps exactly one event across 100 reminder eligibility polls", async () => {
    const fixture = taskFixture();
    fixture.communication.baselineCompleted = true;
    fixture.source.setCurrent(taskRecord({
      [TASK_FIELDS.day]: "2026-08-15",
      [TASK_FIELDS.emmaCustomerStatus]: "Przypomnienie o wizycie",
      [TASK_FIELDS.emmaMailTemplate]: "Przegląd-przypomnienie_o_wizycie",
    }));
    for (let poll = 0; poll < 100; poll += 1) {
      await runTaskSync({
        airtable: fixture.source,
        store: fixture.store,
        communicationStore: fixture.communication,
        requestedMode: "REMINDER_ELIGIBILITY",
        now: () => new Date("2026-08-14T04:30:00Z"),
      });
    }
    expect(fixture.communication.events).toHaveLength(1);
  });

  it("passes an eligible reminder event into the existing delivery pipeline", async () => {
    const fixture = eligibleReminderFixture();
    await runReminderEligibility(fixture);
    const observation = fixture.communication.events[0]!.observation;
    const deliveryStore = new ReminderPipelineDeliveryStore({
      id: "event-reminder",
      sourceRecordId: observation.sourceRecordId,
      scenario: CommunicationScenario.INSPECTION_REMINDER,
      detectedAt: new Date(observation.eventSnapshot.detectedAt as string),
      eventSnapshot: observation.eventSnapshot,
      recipients: [{ id: "recipient-reminder" }],
    });

    await runCommunicationDeliveryPlanner({
      store: deliveryStore,
      timeZone: "Europe/Warsaw",
      now: () => new Date("2026-08-14T04:30:00Z"),
    });

    expect(fixture.communication.events).toHaveLength(1);
    expect(deliveryStore.deliveries).toHaveLength(1);
    expect(deliveryStore.deliveries[0]).toMatchObject({
      scenario: CommunicationScenario.INSPECTION_REMINDER,
      status: CommunicationDeliveryStatus.READY,
    });
    expect(fixture.communication.resendCalls).toBe(0);
  });

  it("does not duplicate an eligibility event during a later incremental sync", async () => {
    const fixture = eligibleReminderFixture();

    await runReminderEligibility(fixture);
    await fixture.run();

    expect(fixture.communication.events).toHaveLength(1);
    expect(fixture.communication.events[0]?.observation.scenario).toBe(
      "INSPECTION_REMINDER",
    );
  });

  it("does not duplicate an incremental event during later reminder eligibility", async () => {
    const fixture = eligibleReminderFixture();

    await fixture.run();
    await runReminderEligibility(fixture);

    expect(fixture.communication.events).toHaveLength(1);
    expect(fixture.communication.events[0]?.observation.scenario).toBe(
      "INSPECTION_REMINDER",
    );
  });

  it("creates a new reminder revision when its signature changes", async () => {
    const fixture = eligibleReminderFixture();
    await runReminderEligibility(fixture);
    fixture.source.setCurrent(reminderTaskRecord("2026-08-16"));

    await runTaskSync({
      airtable: fixture.source,
      store: fixture.store,
      communicationStore: fixture.communication,
      requestedMode: "REMINDER_ELIGIBILITY",
      timeZone: "Europe/Warsaw",
      now: () => new Date("2026-08-15T04:30:00Z"),
    });

    expect(fixture.communication.events).toHaveLength(2);
    expect(fixture.communication.events.map((event) => event.observation.eventSnapshot.day))
      .toEqual(["2026-08-15", "2026-08-16"]);
  });

  it.each(["BASELINE", "RECONCILE"] as const)(
    "does not create historical reminder events during %s",
    async (mode) => {
      const fixture = taskFixture();
      fixture.communication.baselineCompleted = mode === "RECONCILE";
      fixture.source.setCurrent(reminderTaskRecord("2026-08-15"));

      await runTaskSync({
        airtable: fixture.source,
        store: fixture.store,
        communicationStore: fixture.communication,
        ...(mode === "RECONCILE" ? { requestedMode: "RECONCILE" as const } : {}),
        timeZone: "Europe/Warsaw",
        now: () => new Date("2026-08-14T04:30:00Z"),
      });

      expect(fixture.communication.events).toHaveLength(0);
    },
  );

  it("does not emit when an Airtable response contains a reminder that is not tomorrow", async () => {
    const fixture = taskFixture();
    fixture.communication.baselineCompleted = true;
    fixture.source.setCurrent(reminderTaskRecord("2026-08-16"));
    vi.spyOn(fixture.source, "fetchAllRecords").mockImplementationOnce(async () =>
      fixture.source.currentRecords);

    await runReminderEligibility(fixture);

    expect(fixture.communication.events).toHaveLength(0);
  });

  it("marks a failed synchronization without creating an event", async () => {
    const fixture = taskFixture();
    const markFailed = vi.spyOn(fixture.store, "markFailed");
    const logs: string[] = [];
    vi.spyOn(fixture.source, "fetchAllRecords")
      .mockRejectedValueOnce(new Error("offline"));

    await expect(runTaskSync({
      airtable: fixture.source,
      store: fixture.store,
      communicationStore: fixture.communication,
      now: () => new Date("2026-08-11T10:00:00.000Z"),
      log: (message) => logs.push(message),
    })).rejects.toThrow("offline");
    expect(markFailed).toHaveBeenCalledOnce();
    expect(fixture.communication.events).toHaveLength(0);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("INCREMENTAL_SYNC_FAILED stage=TASK");
  });

  it("recovers PENDING_DATA with the same signature and creates exactly one event", async () => {
    const fixture = taskFixture();
    const diagnostics = new MemoryDiagnostics();
    fixture.communication.baselineCompleted = true;
    fixture.source.setCurrent(completedTaskRecord("recTask", "2026-10-12"));
    const input = {
      airtable: fixture.source,
      store: fixture.store,
      communicationStore: fixture.communication,
      diagnostics,
      timeZone: "Europe/Warsaw",
      now: () => new Date("2026-10-12T08:00:00.000Z"),
    };

    await runTaskSync(input);
    expect(fixture.communication.events).toHaveLength(0);
    expect(diagnostics.transitions.at(-1)?.status)
      .toBe(CommunicationDiagnosticStatus.PENDING_DATA);
    expect(diagnostics.transitions.at(-1)?.eventId).toBeUndefined();

    diagnostics.readiness = { ready: true };
    fixture.source.currentRecords = [];
    await runTaskSync(input);
    await runTaskSync(input);

    expect(fixture.communication.events).toHaveLength(1);
    expect(diagnostics.transitions.some((item) =>
      item.status === CommunicationDiagnosticStatus.READY &&
      item.reasonCode === "EVENT_CREATED")).toBe(true);
  });

  it("terminates a pending completed task after the business day without an event", async () => {
    const fixture = taskFixture();
    const diagnostics = new MemoryDiagnostics();
    fixture.communication.baselineCompleted = true;
    fixture.source.setCurrent(completedTaskRecord("recTask", "2026-10-12"));
    let clock = new Date("2026-10-12T08:00:00.000Z");
    const input = {
      airtable: fixture.source,
      store: fixture.store,
      communicationStore: fixture.communication,
      diagnostics,
      timeZone: "Europe/Warsaw",
      now: () => clock,
    };

    await runTaskSync(input);
    fixture.source.currentRecords = [];
    clock = new Date("2026-10-13T08:00:00.000Z");
    await runTaskSync(input);

    expect(fixture.communication.events).toHaveLength(0);
    expect(diagnostics.transitions.at(-1)).toMatchObject({
      status: CommunicationDiagnosticStatus.BLOCKED,
      reasonCode: "PENDING_DATA_EXPIRED",
    });
  });

  it("observes a 23:55 task for 60 minutes but blocks ready data after midnight", async () => {
    const fixture = taskFixture();
    const diagnostics = new MemoryDiagnostics();
    fixture.communication.baselineCompleted = true;
    fixture.source.setCurrent(completedTaskRecord("recTask", "2026-10-12"));
    let clock = new Date("2026-10-12T21:55:00.000Z"); // 23:55 Europe/Warsaw
    const input = {
      airtable: fixture.source,
      store: fixture.store,
      communicationStore: fixture.communication,
      diagnostics,
      timeZone: "Europe/Warsaw",
      now: () => clock,
    };

    await runTaskSync(input);
    expect(fixture.communication.events).toHaveLength(0);
    expect(diagnostics.transitions.at(-1)).toMatchObject({
      status: CommunicationDiagnosticStatus.PENDING_DATA,
      expiresAt: new Date("2026-10-12T22:55:00.000Z"),
    });

    diagnostics.readiness = { ready: true };
    fixture.source.currentRecords = [];
    clock = new Date("2026-10-12T22:01:00.000Z"); // 00:01 next day locally
    await runTaskSync(input);

    expect(fixture.communication.events).toHaveLength(0);
    expect(diagnostics.transitions.at(-1)).toMatchObject({
      status: CommunicationDiagnosticStatus.BLOCKED,
      reasonCode: "READY_BUT_HISTORICAL",
      missingData: {
        expectedInspectionIds: ["recInspectionA", "recInspectionB"],
        lastPendingReasonCode: "INSPECTION_RESULTS_INCOMPLETE",
      },
    });
  });

  it("keeps an incomplete 23:59 task pending after midnight and expires it after 60 minutes", async () => {
    const fixture = taskFixture();
    const diagnostics = new MemoryDiagnostics();
    fixture.communication.baselineCompleted = true;
    fixture.source.setCurrent(completedTaskRecord("recTask", "2026-10-12"));
    let clock = new Date("2026-10-12T21:59:00.000Z");
    const input = {
      airtable: fixture.source,
      store: fixture.store,
      communicationStore: fixture.communication,
      diagnostics,
      timeZone: "Europe/Warsaw",
      now: () => clock,
    };

    await runTaskSync(input);
    fixture.source.currentRecords = [];
    clock = new Date("2026-10-12T22:20:00.000Z");
    await runTaskSync(input);
    expect(fixture.communication.events).toHaveLength(0);
    expect(diagnostics.transitions.at(-1)).toMatchObject({
      status: CommunicationDiagnosticStatus.PENDING_DATA,
      expiresAt: new Date("2026-10-12T22:59:00.000Z"),
    });

    clock = new Date("2026-10-12T23:00:00.000Z");
    await runTaskSync(input);
    expect(fixture.communication.events).toHaveLength(0);
    expect(diagnostics.transitions.at(-1)).toMatchObject({
      status: CommunicationDiagnosticStatus.BLOCKED,
      reasonCode: "PENDING_DATA_EXPIRED",
      missingData: {
        expectedInspectionIds: ["recInspectionA", "recInspectionB"],
        lastPendingReasonCode: "INSPECTION_RESULTS_INCOMPLETE",
      },
    });
  });

  it("allows a 00:01 task to recover within its own business day", async () => {
    const fixture = taskFixture();
    const diagnostics = new MemoryDiagnostics();
    fixture.communication.baselineCompleted = true;
    fixture.source.setCurrent(completedTaskRecord("recTask", "2026-10-13"));
    let clock = new Date("2026-10-12T22:01:00.000Z");
    const input = {
      airtable: fixture.source,
      store: fixture.store,
      communicationStore: fixture.communication,
      diagnostics,
      timeZone: "Europe/Warsaw",
      now: () => clock,
    };

    await runTaskSync(input);
    diagnostics.readiness = { ready: true };
    fixture.source.currentRecords = [];
    clock = new Date("2026-10-12T22:30:00.000Z");
    await runTaskSync(input);

    expect(fixture.communication.events).toHaveLength(1);
    expect(diagnostics.transitions.at(-1)).toMatchObject({
      status: CommunicationDiagnosticStatus.READY,
      reasonCode: "EVENT_CREATED",
    });
  });

  it("resumes a persisted 23:55 pending task after worker restart without historical emission", async () => {
    const fixture = taskFixture();
    const diagnostics = new MemoryDiagnostics();
    fixture.communication.baselineCompleted = true;
    fixture.source.setCurrent(completedTaskRecord("recTask", "2026-10-12"));
    let clock = new Date("2026-10-12T21:55:00.000Z");

    await runTaskSync({
      airtable: fixture.source,
      store: fixture.store,
      communicationStore: fixture.communication,
      diagnostics,
      timeZone: "Europe/Warsaw",
      now: () => clock,
    });

    // A new invocation represents a restarted worker; durable stores and the
    // diagnostic registry retain their state while the incremental feed is empty.
    fixture.source.currentRecords = [];
    diagnostics.readiness = { ready: true };
    clock = new Date("2026-10-12T22:10:00.000Z");
    await runTaskSync({
      airtable: fixture.source,
      store: fixture.store,
      communicationStore: fixture.communication,
      diagnostics,
      timeZone: "Europe/Warsaw",
      now: () => clock,
    });

    expect(fixture.communication.events).toHaveLength(0);
    expect(diagnostics.transitions.at(-1)).toMatchObject({
      status: CommunicationDiagnosticStatus.BLOCKED,
      reasonCode: "READY_BUT_HISTORICAL",
    });

    fixture.source.setCurrent(completedTaskRecord("recTask", "2026-10-12"));
    clock = new Date("2026-10-12T22:20:00.000Z");
    await runTaskSync({
      airtable: fixture.source,
      store: fixture.store,
      communicationStore: fixture.communication,
      diagnostics,
      timeZone: "Europe/Warsaw",
      now: () => clock,
    });
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

function eligibleReminderFixture() {
  const fixture = taskFixture();
  fixture.communication.baselineCompleted = true;
  fixture.source.setCurrent(reminderTaskRecord("2026-08-15"));
  return fixture;
}

function runReminderEligibility(fixture: ReturnType<typeof taskFixture>) {
  return runTaskSync({
    airtable: fixture.source,
    store: fixture.store,
    communicationStore: fixture.communication,
    requestedMode: "REMINDER_ELIGIBILITY",
    timeZone: "Europe/Warsaw",
    now: () => new Date("2026-08-14T04:30:00Z"),
  });
}

function reminderTaskRecord(day: string): AirtableRecord {
  return taskRecord({
    [TASK_FIELDS.day]: day,
    [TASK_FIELDS.sourceHospitalLink]: ["recHospital"],
    [TASK_FIELDS.emmaCustomerStatus]: "Przypomnienie o wizycie",
    [TASK_FIELDS.emmaMailTemplate]: "Przegląd-przypomnienie_o_wizycie",
  });
}

function inspectionDateTaskRecord(
  scenario: "INSPECTION_DATE_CONFIRMED" | "INSPECTION_DATE_PROPOSED",
  day: string,
): AirtableRecord {
  return taskRecord({
    [TASK_FIELDS.day]: day,
    [TASK_FIELDS.emmaCustomerStatus]: scenario === "INSPECTION_DATE_CONFIRMED"
      ? "Ustalono termin wizyty" : "Poinformowano o wizycie",
    [TASK_FIELDS.emmaMailTemplate]: scenario === "INSPECTION_DATE_CONFIRMED"
      ? "Przegląd-informacja_o_umówionej_wizycie"
      : "Przegląd-informacja_o_nadchodzącej_wizycie",
  });
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

function completedTaskRecord(id: string, day: string): AirtableRecord {
  return {
    ...taskRecord({
      [TASK_FIELDS.day]: day,
      [TASK_FIELDS.completed]: true,
      [TASK_FIELDS.status]: "Zakończone",
      [TASK_FIELDS.emmaCustomerStatus]: "Wizyta zakończona",
      [TASK_FIELDS.emmaMailTemplate]: "Przegląd-podsumowanie_wizyty",
    }),
    id,
  };
}

function inspectionRecord(id: string, performedAt: string): AirtableRecord {
  return {
    id,
    createdTime: "2026-10-10T07:00:00.000Z",
    fields: { [INSPECTION_FIELDS.performedAt]: performedAt },
  };
}
