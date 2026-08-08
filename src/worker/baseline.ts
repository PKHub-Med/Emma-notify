import { SyncEntityType } from "../generated/prisma/enums.js";
import {
  AIRTABLE_TABLE_IDS,
  CONTACT_FIELD_IDS,
  INSPECTION_FIELD_IDS,
  SERVICE_ORDER_FIELD_IDS,
} from "../airtable/field-ids.js";
import { mapInspection, mapServiceOrder, type MappedCase } from "../airtable/mappers.js";
import {
  mapContact,
  resolveRecipient,
  type Contact,
} from "../airtable/recipient.js";
import type { AirtableRecordSource } from "../airtable/types.js";
import type {
  BaselineEntityType,
  BaselineSafetyCounts,
  BaselineStore,
} from "./baseline-store.js";

const BASELINE_ENTITY_TYPES = [
  SyncEntityType.CONTACT,
  SyncEntityType.SERVICE_ORDER,
  SyncEntityType.INSPECTION,
] as const satisfies readonly BaselineEntityType[];

export type BaselineStats = {
  contactsFetched: number;
  eligibleContacts: number;
  serviceOrdersFetched: number;
  serviceOrdersStored: number;
  serviceOrdersWithoutEligibleRecipient: number;
  inspectionsFetched: number;
  inspectionsStored: number;
  inspectionsWithoutEligibleRecipient: number;
  caseRecipientsStored: number;
  invalidDueDates: number;
  durationMs: number;
  caseEventsCreated: number;
  buffersCreated: number;
};

export type BaselineDependencies = {
  airtable: AirtableRecordSource;
  store: BaselineStore;
  now?: () => Date;
  log?: (message: string) => void;
};

export async function runBaseline(
  dependencies: BaselineDependencies,
): Promise<BaselineStats | null> {
  const completionState = await dependencies.store.getCompletionState(
    BASELINE_ENTITY_TYPES,
  );
  if (completionState.every(Boolean)) {
    dependencies.log?.("[baseline] skipped reason=already_completed");
    return null;
  }

  const now = dependencies.now ?? (() => new Date());
  const startedAt = now();
  await dependencies.store.markRunning(BASELINE_ENTITY_TYPES, startedAt);
  const safetyBefore = await dependencies.store.getSafetyCounts();

  try {
    const contactRecords = await dependencies.airtable.fetchAllRecords(
      AIRTABLE_TABLE_IDS.contacts,
      CONTACT_FIELD_IDS,
    );
    const contacts = new Map(
      contactRecords.map(mapContact).map((contact) => [contact.airtableRecordId, contact]),
    );
    const eligibleContacts = [...contacts.values()].filter((contact) =>
      resolveRecipient(contact.airtableRecordId, contact).eligible).length;

    const stats = emptyStats();
    stats.contactsFetched = contactRecords.length;
    stats.eligibleContacts = eligibleContacts;

    const serviceOrders = await dependencies.airtable.fetchAllRecords(
      AIRTABLE_TABLE_IDS.serviceOrders,
      SERVICE_ORDER_FIELD_IDS,
    );
    stats.serviceOrdersFetched = serviceOrders.length;
    for (const record of serviceOrders) {
      const mappedCase = mapServiceOrder(record);
      const hasEligibleRecipient = await storeCase(
        dependencies.store,
        mappedCase,
        contacts,
        startedAt,
      );
      stats.serviceOrdersStored += 1;
      stats.caseRecipientsStored += mappedCase.contactRecordIds.length;
      if (!hasEligibleRecipient) stats.serviceOrdersWithoutEligibleRecipient += 1;
    }

    const inspections = await dependencies.airtable.fetchAllRecords(
      AIRTABLE_TABLE_IDS.inspections,
      INSPECTION_FIELD_IDS,
    );
    stats.inspectionsFetched = inspections.length;
    for (const record of inspections) {
      const mappedCase = mapInspection(record);
      const hasEligibleRecipient = await storeCase(
        dependencies.store,
        mappedCase,
        contacts,
        startedAt,
      );
      stats.inspectionsStored += 1;
      stats.caseRecipientsStored += mappedCase.contactRecordIds.length;
      if (mappedCase.invalidDueDate) stats.invalidDueDates += 1;
      if (!hasEligibleRecipient) stats.inspectionsWithoutEligibleRecipient += 1;
    }

    const safetyAfter = await dependencies.store.getSafetyCounts();
    applySafetyDeltas(stats, safetyBefore, safetyAfter);
    if (stats.caseEventsCreated !== 0 || stats.buffersCreated !== 0) {
      throw new Error("Baseline safety invariant violated");
    }

    const completedAt = now();
    stats.durationMs = Math.max(0, completedAt.getTime() - startedAt.getTime());
    await dependencies.store.markCompleted(BASELINE_ENTITY_TYPES, completedAt);
    await dependencies.store.setWorkerLastSync(completedAt);
    dependencies.log?.(`[baseline] completed ${formatStats(stats)}`);
    return stats;
  } catch (error: unknown) {
    await dependencies.store.markFailed(BASELINE_ENTITY_TYPES, now());
    throw error;
  }
}

async function storeCase(
  store: BaselineStore,
  mappedCase: MappedCase,
  contacts: ReadonlyMap<string, Contact>,
  seenAt: Date,
): Promise<boolean> {
  const trackedCaseId = await store.upsertCase(mappedCase, seenAt);
  const recipients = mappedCase.contactRecordIds.map((contactRecordId) =>
    resolveRecipient(contactRecordId, contacts.get(contactRecordId)));
  await store.syncRecipients(trackedCaseId, recipients, seenAt);
  return recipients.some((recipient) => recipient.eligible);
}

function emptyStats(): BaselineStats {
  return {
    contactsFetched: 0,
    eligibleContacts: 0,
    serviceOrdersFetched: 0,
    serviceOrdersStored: 0,
    serviceOrdersWithoutEligibleRecipient: 0,
    inspectionsFetched: 0,
    inspectionsStored: 0,
    inspectionsWithoutEligibleRecipient: 0,
    caseRecipientsStored: 0,
    invalidDueDates: 0,
    durationMs: 0,
    caseEventsCreated: 0,
    buffersCreated: 0,
  };
}

function applySafetyDeltas(
  stats: BaselineStats,
  before: BaselineSafetyCounts,
  after: BaselineSafetyCounts,
): void {
  stats.caseEventsCreated = after.caseEvents - before.caseEvents;
  stats.buffersCreated =
    after.notificationBuffers - before.notificationBuffers +
    (after.bufferItems - before.bufferItems);
}

function formatStats(stats: BaselineStats): string {
  return Object.entries(stats)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
}
