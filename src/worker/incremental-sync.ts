import {
  EventType,
  SyncEntityType,
} from "../generated/prisma/enums.js";
import {
  AIRTABLE_TABLE_IDS,
  CONTACT_FIELD_IDS,
  INSPECTION_FIELDS,
  INSPECTION_FIELD_IDS,
  SERVICE_ORDER_FIELDS,
  SERVICE_ORDER_FIELD_IDS,
} from "../airtable/field-ids.js";
import {
  mapInspection,
  mapServiceOrder,
  type MappedCase,
} from "../airtable/mappers.js";
import {
  mapContact,
  resolveRecipient,
  type Contact,
} from "../airtable/recipient.js";
import type {
  AirtableIncrementalSource,
  AirtableRecord,
} from "../airtable/types.js";
import {
  createEventFingerprint,
  normalizeStatus,
} from "./notification-domain.js";
import type {
  IncrementalEntityType,
  IncrementalStore,
} from "./incremental-store.js";
import {
  buildServiceOrderObservation,
  observeCommunication,
  type CommunicationEventStore,
} from "./communication-event.js";
import {
  atIncrementalStage,
  formatIncrementalSyncFailure,
  IncrementalSyncStageError,
  type IncrementalSyncStage,
} from "./incremental-sync-error.js";

export type IncrementalSyncOptions = {
  overlapSeconds: number;
  quietMinutes: number;
  legacyNotificationsEnabled: boolean;
};

export type IncrementalSyncStats = {
  serviceOrdersFetched: number;
  inspectionsFetched: number;
  statusChangesDetected: number;
  eventsCreated: number;
  duplicateEventsIgnored: number;
  triggeringEventsWithoutRecipient: number;
  buffersCreated: number;
  buffersReset: number;
  bufferItemsCreated: number;
  communicationEventsCreated: number;
  durationMs: number;
};

type EntityDefinition = {
  entityType: IncrementalEntityType;
  tableId: string;
  fieldIds: readonly string[];
  modifiedFieldId: string;
  eventType:
    | typeof EventType.SERVICE_STATUS_CHANGED
    | typeof EventType.INSPECTION_STATUS_CHANGED;
  map: (record: AirtableRecord) => MappedCase;
  fetchedStat: "serviceOrdersFetched" | "inspectionsFetched";
};

const ENTITY_DEFINITIONS: readonly EntityDefinition[] = [
  {
    entityType: SyncEntityType.SERVICE_ORDER,
    tableId: AIRTABLE_TABLE_IDS.serviceOrders,
    fieldIds: SERVICE_ORDER_FIELD_IDS,
    modifiedFieldId: SERVICE_ORDER_FIELDS.sourceModifiedAt,
    eventType: EventType.SERVICE_STATUS_CHANGED,
    map: mapServiceOrder,
    fetchedStat: "serviceOrdersFetched",
  },
  {
    entityType: SyncEntityType.INSPECTION,
    tableId: AIRTABLE_TABLE_IDS.inspections,
    fieldIds: INSPECTION_FIELD_IDS,
    modifiedFieldId: INSPECTION_FIELDS.sourceModifiedAt,
    eventType: EventType.INSPECTION_STATUS_CHANGED,
    map: mapInspection,
    fetchedStat: "inspectionsFetched",
  },
];

export async function runIncrementalSync(dependencies: {
  airtable: AirtableIncrementalSource;
  store: IncrementalStore;
  options: IncrementalSyncOptions;
  communicationStore?: CommunicationEventStore;
  now?: () => Date;
  log?: (message: string) => void;
}): Promise<IncrementalSyncStats> {
  const now = dependencies.now ?? (() => new Date());
  const startedAt = now();
  const stats = emptyStats();
  const contactCache = new Map<string, Contact>();
  try {
    const serviceCommunicationEnabled = dependencies.communicationStore
      ? await atIncrementalStage("COMMUNICATION", () =>
          dependencies.communicationStore!.isBaselineCompleted("SERVICE_ORDER"))
      : false;

    for (const definition of ENTITY_DEFINITIONS) {
      await syncEntity(
      definition,
      dependencies.airtable,
      dependencies.store,
      dependencies.options,
      startedAt,
      now,
      contactCache,
      stats,
      dependencies.communicationStore,
      serviceCommunicationEnabled,
      dependencies.log,
      );
    }

    const completedAt = now();
    stats.durationMs = Math.max(0, completedAt.getTime() - startedAt.getTime());
    await atIncrementalStage("DB", () => dependencies.store.setWorkerLastSync(completedAt));
    dependencies.log?.(`[incremental-sync] completed ${formatStats(stats)}`);
    return stats;
  } catch (error: unknown) {
    const failedAt = now();
    dependencies.log?.(formatIncrementalSyncFailure({
      error,
      durationMs: failedAt.getTime() - startedAt.getTime(),
    }));
    throw error;
  }
}

export function buildLastModifiedFormula(fieldId: string, since: Date): string {
  return `IS_AFTER({${fieldId}}, DATETIME_PARSE('${since.toISOString()}'))`;
}

async function syncEntity(
  definition: EntityDefinition,
  airtable: AirtableIncrementalSource,
  store: IncrementalStore,
  options: IncrementalSyncOptions,
  startedAt: Date,
  now: () => Date,
  contactCache: Map<string, Contact>,
  stats: IncrementalSyncStats,
  communicationStore: CommunicationEventStore | undefined,
  serviceCommunicationEnabled: boolean,
  log: ((message: string) => void) | undefined,
): Promise<void> {
  const checkpoint = await atIncrementalStage("DB", () =>
    store.getCheckpoint(definition.entityType));
  if (!checkpoint) {
    throw new IncrementalSyncStageError(
      "DB",
      new Error(`Baseline checkpoint missing for ${definition.entityType}`),
    );
  }
  await atIncrementalStage("DB", () => store.markRunning(definition.entityType, startedAt));

  try {
    const effectiveSince = new Date(
      checkpoint.getTime() - options.overlapSeconds * 1_000,
    );
    const entityStage = definition.entityType as IncrementalSyncStage;
    const records = await atIncrementalStage(entityStage, () =>
      airtable.fetchAllRecords(
        definition.tableId,
        definition.fieldIds,
        {
          filterByFormula: buildLastModifiedFormula(
            definition.modifiedFieldId,
            effectiveSince,
          ),
        },
      ));
    stats[definition.fetchedStat] += records.length;

    for (const record of records) {
      await processRecord(
        definition,
        record,
        airtable,
        store,
        options.quietMinutes,
        options.legacyNotificationsEnabled,
        now(),
        contactCache,
        stats,
        communicationStore,
        serviceCommunicationEnabled,
        log,
      );
    }

    await atIncrementalStage("DB", () =>
      store.markSuccessful(definition.entityType, startedAt));
  } catch (error: unknown) {
    // Preserve the operation that caused the poll to fail. Checkpoint status is
    // best-effort here and must not mask the primary stage/error metadata.
    await store.markFailed(definition.entityType, now()).catch(() => undefined);
    throw error;
  }
}

async function processRecord(
  definition: EntityDefinition,
  record: AirtableRecord,
  airtable: AirtableIncrementalSource,
  store: IncrementalStore,
  quietMinutes: number,
  legacyNotificationsEnabled: boolean,
  detectedAt: Date,
  contactCache: Map<string, Contact>,
  stats: IncrementalSyncStats,
  communicationStore: CommunicationEventStore | undefined,
  serviceCommunicationEnabled: boolean,
  log: ((message: string) => void) | undefined,
): Promise<void> {
  const entityStage = definition.entityType as IncrementalSyncStage;
  const mappedCase = await atIncrementalStage(entityStage, async () =>
    definition.map(record));
  const recipients = await atIncrementalStage(entityStage, () =>
    resolveCurrentRecipients(mappedCase.contactRecordIds, airtable, contactCache));
  const storedCase = await atIncrementalStage("DB", () => store.findCase(mappedCase));

  if (!storedCase || !legacyNotificationsEnabled) {
    const trackedCaseId = await atIncrementalStage("DB", () =>
      store.upsertCaseWithoutEvent(mappedCase, detectedAt));
    await atIncrementalStage("DB", () =>
      store.syncRecipients(trackedCaseId, recipients, detectedAt));
    if (
      !legacyNotificationsEnabled &&
      definition.entityType === SyncEntityType.SERVICE_ORDER &&
      communicationStore
    ) {
      const result = await atIncrementalStage("COMMUNICATION", () => observeCommunication({
        store: communicationStore,
        observation: buildServiceOrderObservation(mappedCase, detectedAt),
        allowEvent: serviceCommunicationEnabled,
        detectedAt,
        ...(log ? { log } : {}),
      }));
      if (result.outcome === "CREATED") stats.communicationEventsCreated += 1;
    }
    return;
  }

  await atIncrementalStage("DB", () =>
    store.syncRecipients(storedCase.id, recipients, detectedAt));
  const oldStatus = normalizeStatus(storedCase.currentStatus);
  const newStatus = normalizeStatus(mappedCase.currentStatus);
  if (oldStatus === newStatus) {
    await atIncrementalStage("DB", () =>
      store.upsertCaseWithoutEvent(mappedCase, detectedAt));
    return;
  }

  stats.statusChangesDetected += 1;
  const result = await atIncrementalStage("DB", () => store.processStatusChange({
    trackedCaseId: storedCase.id,
    mappedCase: { ...mappedCase, currentStatus: newStatus },
    eventType: definition.eventType,
    oldStatus,
    newStatus,
    fingerprint: createEventFingerprint({
      caseType: mappedCase.caseType,
      airtableRecordId: mappedCase.airtableRecordId,
      eventType: definition.eventType,
      fieldName: "STATUS",
      oldValue: oldStatus,
      newValue: newStatus,
      sourceModifiedAt: mappedCase.sourceModifiedAt,
    }),
    detectedAt,
    quietMinutes,
  }));

  if (result.duplicate) {
    stats.duplicateEventsIgnored += 1;
    return;
  }
  stats.eventsCreated += 1;
  if (result.withoutRecipient) stats.triggeringEventsWithoutRecipient += 1;
  stats.buffersCreated += result.buffersCreated;
  stats.buffersReset += result.buffersReset;
  stats.bufferItemsCreated += result.bufferItemsCreated;
}

async function resolveCurrentRecipients(
  contactRecordIds: readonly string[],
  airtable: AirtableIncrementalSource,
  cache: Map<string, Contact>,
) {
  for (const contactRecordId of contactRecordIds) {
    if (!cache.has(contactRecordId)) {
      const record = await airtable.fetchRecord(
        AIRTABLE_TABLE_IDS.contacts,
        contactRecordId,
        CONTACT_FIELD_IDS,
      );
      cache.set(contactRecordId, mapContact(record));
    }
  }
  return contactRecordIds.map((contactRecordId) =>
    resolveRecipient(contactRecordId, cache.get(contactRecordId)));
}

function emptyStats(): IncrementalSyncStats {
  return {
    serviceOrdersFetched: 0,
    inspectionsFetched: 0,
    statusChangesDetected: 0,
    eventsCreated: 0,
    duplicateEventsIgnored: 0,
    triggeringEventsWithoutRecipient: 0,
    buffersCreated: 0,
    buffersReset: 0,
    bufferItemsCreated: 0,
    communicationEventsCreated: 0,
    durationMs: 0,
  };
}

function formatStats(stats: IncrementalSyncStats): string {
  return Object.entries(stats)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
}
