import {
  AIRTABLE_TABLE_IDS,
  SERVICE_ORDER_FIELD_IDS,
} from "../airtable/field-ids.js";
import { mapServiceOrder } from "../airtable/mappers.js";
import type { AirtableRecordSource } from "../airtable/types.js";
import {
  buildServiceOrderObservation,
  observeCommunication,
  type CommunicationEventStore,
} from "./communication-event.js";
import type { MappedCase } from "../airtable/mappers.js";

export interface ServiceCommunicationBaselineCaseStore {
  upsertCaseWithoutEvent(mappedCase: MappedCase, seenAt: Date): Promise<string>;
}

export async function runServiceCommunicationBaseline(input: {
  airtable: AirtableRecordSource;
  caseStore: ServiceCommunicationBaselineCaseStore;
  communicationStore: CommunicationEventStore;
  now?: () => Date;
  log?: (message: string) => void;
}): Promise<{ records: number; skipped: boolean }> {
  if (await input.communicationStore.isBaselineCompleted("SERVICE_ORDER")) {
    input.log?.("[communication-baseline] service-orders skipped reason=completed");
    return { records: 0, skipped: true };
  }

  const now = input.now ?? (() => new Date());
  const records = await input.airtable.fetchAllRecords(
    AIRTABLE_TABLE_IDS.serviceOrders,
    SERVICE_ORDER_FIELD_IDS,
  );

  for (const record of records) {
    const detectedAt = now();
    const serviceOrder = mapServiceOrder(record);
    await input.caseStore.upsertCaseWithoutEvent(serviceOrder, detectedAt);
    await observeCommunication({
      store: input.communicationStore,
      observation: buildServiceOrderObservation(serviceOrder, detectedAt),
      allowEvent: false,
      detectedAt,
      ...(input.log ? { log: input.log } : {}),
    });
  }

  const completedAt = now();
  await input.communicationStore.markBaselineCompleted(
    "SERVICE_ORDER",
    completedAt,
  );
  input.log?.(
    `[communication-baseline] service-orders completed records=${records.length}`,
  );
  return { records: records.length, skipped: false };
}
