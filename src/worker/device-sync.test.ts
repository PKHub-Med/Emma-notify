import { describe, expect, it } from "vitest";
import { DEVICE_FIELDS } from "../airtable/field-ids.js";
import type { MappedDevice } from "../airtable/device.js";
import type {
  AirtableIncrementalSource,
  AirtableListOptions,
  AirtableRecord,
} from "../airtable/types.js";
import {
  buildDeviceIncrementalFormula,
  DEVICE_EDITABLE_FIELD_IDS,
  runDeviceSync,
  type DeviceSyncStore,
} from "./device-sync.js";

class FakeAirtable implements AirtableIncrementalSource {
  records: AirtableRecord[] = [];
  lastOptions: AirtableListOptions | undefined;
  async fetchAllRecords(
    _tableId: string,
    _fields: readonly string[],
    options?: AirtableListOptions,
  ) {
    this.lastOptions = options;
    return this.records;
  }
  async fetchAllRecordsWithMetrics(
    tableId: string,
    fields: readonly string[],
    options?: AirtableListOptions,
  ) {
    return {
      records: await this.fetchAllRecords(tableId, fields, options),
      metrics: { pagesFetched: 1, requestsMade: 1 },
    };
  }
  async fetchRecord(): Promise<AirtableRecord> { throw new Error("not used"); }
}

class MemoryStore implements DeviceSyncStore {
  devices = new Map<string, MappedDevice>();
  checkpoint: { baselineCompletedAt: Date | null; lastSuccessfulSyncAt: Date | null } | null = null;
  getCheckpoint() { return Promise.resolve(this.checkpoint); }
  markRunning() { return Promise.resolve(); }
  async upsert(device: MappedDevice) { this.devices.set(device.airtableRecordId, device); }
  async markSuccessful(at: Date, baseline: boolean) {
    this.checkpoint = {
      baselineCompletedAt: this.checkpoint?.baselineCompletedAt ?? (baseline ? at : null),
      lastSuccessfulSyncAt: at,
    };
  }
  markFailed() { return Promise.resolve(); }
}

describe("Device current-state synchronization", () => {
  it("creates one Device, then updates the same Airtable ID without duplication", async () => {
    const source = new FakeAirtable();
    const store = new MemoryStore();
    source.records = [deviceRecord("recDevice", "USG")];
    const first = await run(source, store);
    source.records = [deviceRecord("recDevice", "USG po zmianie")];
    const second = await run(source, store);
    expect(first.mode).toBe("BASELINE");
    expect(second.mode).toBe("INCREMENTAL");
    expect(store.devices.size).toBe(1);
    expect(store.devices.get("recDevice")?.name).toBe("USG po zmianie");
  });

  it("keeps two different Device records with the same name", async () => {
    const source = new FakeAirtable();
    const store = new MemoryStore();
    source.records = [deviceRecord("recA", "USG"), deviceRecord("recB", "USG")];
    await run(source, store);
    expect(store.devices.size).toBe(2);
  });

  it("keeps zero new Devices across 100 empty incremental polls", async () => {
    const source = new FakeAirtable();
    const store = new MemoryStore();
    source.records = [deviceRecord("recDevice", "USG")];
    await run(source, store);
    source.records = [];
    for (let poll = 0; poll < 100; poll += 1) {
      const stats = await run(source, store);
      expect(stats).toMatchObject({
        mode: "INCREMENTAL", recordsFetched: 0, pagesFetched: 1, requestsMade: 1,
      });
    }
    expect(store.devices.size).toBe(1);
  });

  it("runs reconcile independently without an incremental formula", async () => {
    const source = new FakeAirtable();
    const store = new MemoryStore();
    await run(source, store);
    const stats = await runDeviceSync({
      airtable: source,
      store,
      requestedMode: "RECONCILE",
      now: fixedNow,
    });
    expect(stats.mode).toBe("RECONCILE");
    expect(source.lastOptions).toBeUndefined();
  });

  it("uses only confirmed editable Device fields in LAST_MODIFIED_TIME", () => {
    const formula = buildDeviceIncrementalFormula(new Date("2026-08-14T08:00:00Z"));
    for (const fieldId of DEVICE_EDITABLE_FIELD_IDS) {
      expect(formula).toContain(`{${fieldId}}`);
    }
    expect(formula).not.toContain(`{${DEVICE_FIELDS.sourceModifiedAt}}`);
  });
});

function run(source: FakeAirtable, store: MemoryStore) {
  return runDeviceSync({ airtable: source, store, now: fixedNow });
}

function fixedNow() { return new Date("2026-08-14T10:00:00.000Z"); }

function deviceRecord(id: string, name: string): AirtableRecord {
  return {
    id,
    createdTime: "2026-08-01T08:00:00.000Z",
    fields: {
      [DEVICE_FIELDS.name]: name,
      [DEVICE_FIELDS.hospitalLink]: ["hospital-A"],
      [DEVICE_FIELDS.sourceModifiedAt]: "2026-08-14T09:00:00.000Z",
    },
  };
}
