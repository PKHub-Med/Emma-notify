import { describe, expect, it } from "vitest";
import type { MappedCase } from "../airtable/mappers.js";
import type { ResolvedRecipient } from "../airtable/recipient.js";
import type { AirtableRecord, AirtableRecordSource } from "../airtable/types.js";
import {
  AIRTABLE_TABLE_IDS,
  CONTACT_FIELDS,
  SERVICE_ORDER_FIELDS,
} from "../airtable/field-ids.js";
import { runBaseline } from "./baseline.js";
import type {
  BaselineEntityType,
  BaselineSafetyCounts,
  BaselineStore,
} from "./baseline-store.js";

class FakeAirtable implements AirtableRecordSource {
  calls = 0;

  async fetchAllRecords(tableId: string): Promise<AirtableRecord[]> {
    this.calls += 1;
    if (tableId === AIRTABLE_TABLE_IDS.contacts) {
      return [record("recContact", {
        [CONTACT_FIELDS.contactable]: "TAK",
        [CONTACT_FIELDS.email]: "customer@example.com",
      })];
    }
    if (tableId === AIRTABLE_TABLE_IDS.serviceOrders) {
      return [record("recService", {
        [SERVICE_ORDER_FIELDS.businessNumber]: "SO-1",
        [SERVICE_ORDER_FIELDS.contactLinks]: ["recContact"],
      })];
    }
    return [];
  }
}

class FakeStore implements BaselineStore {
  completionState = [false, false, false];
  cases: MappedCase[] = [];
  recipients: ResolvedRecipient[] = [];
  completed = false;
  lastSyncAt: Date | null = null;
  safetyCounts: BaselineSafetyCounts = {
    caseEvents: 0,
    notificationBuffers: 0,
    bufferItems: 0,
  };

  async getCompletionState(): Promise<boolean[]> {
    return this.completionState;
  }
  async markRunning(
    _entityTypes: readonly BaselineEntityType[],
    _at: Date,
  ): Promise<void> {}
  async upsertCase(mappedCase: MappedCase): Promise<string> {
    this.cases.push(mappedCase);
    return `case-${mappedCase.airtableRecordId}`;
  }
  async syncRecipients(
    _trackedCaseId: string,
    recipients: readonly ResolvedRecipient[],
  ): Promise<void> {
    this.recipients.push(...recipients);
  }
  async getSafetyCounts(): Promise<BaselineSafetyCounts> {
    return { ...this.safetyCounts };
  }
  async markCompleted(): Promise<void> {
    this.completed = true;
  }
  async markFailed(): Promise<void> {}
  async setWorkerLastSync(at: Date): Promise<void> {
    this.lastSyncAt = at;
  }
}

describe("runBaseline", () => {
  it("stores cases and recipients without creating events or buffers", async () => {
    const airtable = new FakeAirtable();
    const store = new FakeStore();
    const times = [
      new Date("2026-08-08T10:00:00.000Z"),
      new Date("2026-08-08T10:00:01.000Z"),
    ];
    let timeIndex = 0;

    const stats = await runBaseline({
      airtable,
      store,
      now: () => times[timeIndex++] ?? times[1]!,
    });

    expect(stats).toMatchObject({
      contactsFetched: 1,
      serviceOrdersStored: 1,
      caseRecipientsStored: 1,
      caseEventsCreated: 0,
      buffersCreated: 0,
    });
    expect(store.cases).toHaveLength(1);
    expect(store.recipients).toHaveLength(1);
    expect(store.recipients[0]?.eligible).toBe(true);
    expect(store.completed).toBe(true);
    expect(store.lastSyncAt).toEqual(times[1]);
  });

  it("does not fetch Airtable when every baseline is already complete", async () => {
    const airtable = new FakeAirtable();
    const store = new FakeStore();
    store.completionState = [true, true, true];

    await expect(runBaseline({ airtable, store })).resolves.toBeNull();
    expect(airtable.calls).toBe(0);
  });
});

function record(id: string, fields: Record<string, unknown>): AirtableRecord {
  return {
    id,
    createdTime: "2026-08-01T08:00:00.000Z",
    fields,
  };
}
