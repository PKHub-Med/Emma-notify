import { describe, expect, it } from "vitest";
import {
  SERVICE_ORDER_FIELDS,
} from "../airtable/field-ids.js";
import { mapServiceOrder, type MappedCase } from "../airtable/mappers.js";
import type {
  AirtableListOptions,
  AirtableRecord,
  AirtableRecordSource,
} from "../airtable/types.js";
import {
  buildServiceOrderObservation,
  createCommunicationFingerprint,
  observeCommunication,
  type CommunicationEventStore,
  type CommunicationObservation,
  type CommunicationObservationResult,
} from "./communication-event.js";
import { runServiceCommunicationBaseline } from "./service-communication-baseline.js";

class FakeAirtable implements AirtableRecordSource {
  records: AirtableRecord[] = [];
  fetches = 0;

  async fetchAllRecords(
    _tableId: string,
    _fieldIds: readonly string[],
    _options?: AirtableListOptions,
  ): Promise<AirtableRecord[]> {
    this.fetches += 1;
    return this.records;
  }
}

class MemoryCaseStore {
  readonly cases = new Map<string, MappedCase>();

  async upsertCaseWithoutEvent(mappedCase: MappedCase): Promise<string> {
    this.cases.set(mappedCase.airtableRecordId, mappedCase);
    return mappedCase.airtableRecordId;
  }
}

class MemoryCommunicationStore implements CommunicationEventStore {
  baselineCompleted = false;
  readonly cursors = new Map<string, { signature: string; revision: number }>();
  readonly events: string[] = [];

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
    const cursor = this.cursors.get(observation.sourceRecordId);
    if (cursor?.signature === observation.signature) {
      return { outcome: "UNCHANGED", revision: cursor.revision };
    }
    const revision = cursor ? cursor.revision + 1 : 0;
    this.cursors.set(observation.sourceRecordId, {
      signature: observation.signature,
      revision,
    });
    if (!observation.scenario) return { outcome: "NO_SCENARIO", revision };
    if (!allowEvent) return { outcome: "SUPPRESSED", revision };
    const fingerprint = createCommunicationFingerprint(observation, revision);
    this.events.push(fingerprint);
    return { outcome: "CREATED", revision, fingerprint };
  }
}

describe("service-order communication baseline", () => {
  it("caches existing EMMA fields and establishes baseline without backlog events", async () => {
    const fixture = serviceFixture();
    fixture.airtable.records = [serviceRecord("recExisting")];

    const result = await fixture.run();

    expect(result).toEqual({ records: 1, skipped: false });
    expect(fixture.communication.baselineCompleted).toBe(true);
    expect(fixture.communication.events).toHaveLength(0);
    expect(fixture.caseStore.cases.get("recExisting")).toMatchObject({
      emmaCustomerStatus: "Diagnostyka",
      emmaMailTemplate: "Naprawa-zmiana_stanu",
      serviceOrderType: "NAPRAWA",
    });
  });

  it("is restart-safe and does not fetch or replay after completed baseline", async () => {
    const fixture = serviceFixture();
    fixture.airtable.records = [serviceRecord("recExisting")];
    await fixture.run();

    const second = await fixture.run();

    expect(second).toEqual({ records: 0, skipped: true });
    expect(fixture.airtable.fetches).toBe(1);
    expect(fixture.communication.events).toHaveLength(0);
  });

  it("allows a new service order after baseline to create REPAIR_RECEIVED", async () => {
    const fixture = serviceFixture();
    fixture.airtable.records = [serviceRecord("recExisting")];
    await fixture.run();
    const detectedAt = new Date("2026-08-12T10:00:00.000Z");
    const newOrder = mapServiceOrder(serviceRecord("recNew"));

    await observeCommunication({
      store: fixture.communication,
      observation: buildServiceOrderObservation(newOrder, detectedAt),
      allowEvent: await fixture.communication.isBaselineCompleted("SERVICE_ORDER"),
      detectedAt,
    });
    await observeCommunication({
      store: fixture.communication,
      observation: buildServiceOrderObservation(newOrder, detectedAt),
      allowEvent: await fixture.communication.isBaselineCompleted("SERVICE_ORDER"),
      detectedAt,
    });

    expect(fixture.communication.events).toHaveLength(1);
  });
});

function serviceFixture() {
  const airtable = new FakeAirtable();
  const caseStore = new MemoryCaseStore();
  const communication = new MemoryCommunicationStore();
  return {
    airtable,
    caseStore,
    communication,
    run: () => runServiceCommunicationBaseline({
      airtable,
      caseStore,
      communicationStore: communication,
      now: () => new Date("2026-08-12T09:00:00.000Z"),
    }),
  };
}

function serviceRecord(id: string): AirtableRecord {
  return {
    id,
    createdTime: "2026-01-01T08:00:00.000Z",
    fields: {
      [SERVICE_ORDER_FIELDS.businessNumber]: "SO-1",
      [SERVICE_ORDER_FIELDS.serviceOrderType]: "NAPRAWA",
      [SERVICE_ORDER_FIELDS.customerStatus]: "Legacy status",
      [SERVICE_ORDER_FIELDS.emmaCustomerStatus]: "Diagnostyka",
      [SERVICE_ORDER_FIELDS.emmaMailTemplate]: "Naprawa-zmiana_stanu",
      [SERVICE_ORDER_FIELDS.sourceModifiedAt]: "2026-08-12T08:00:00.000Z",
    },
  };
}
