import "dotenv/config";
import { AIRTABLE_TABLE_IDS, CONTACT_FIELD_IDS, DEVICE_FIELD_IDS, HOSPITAL_FIELD_IDS, HOSPITAL_FIELDS,
  INSPECTION_FIELD_IDS, SERVICE_ORDER_FIELD_IDS, TASK_FIELD_IDS } from "../airtable/field-ids.js";
import { AirtableClient } from "../airtable/client.js";
import { mapInspection, mapServiceOrder } from "../airtable/mappers.js";
import { mapContact, resolveRecipient } from "../airtable/recipient.js";
import { mapDevice } from "../airtable/device.js";
import { mapHospital } from "../airtable/hospital.js";
import { mapTask } from "../airtable/task.js";
import type { AirtableIncrementalSource, AirtableRecord } from "../airtable/types.js";
import { AirtableRequestError } from "../airtable/client.js";
import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import { CaseType } from "../generated/prisma/enums.js";
import { createPrismaClient } from "../db/prisma.js";
import { PrismaBaselineStore, type BaselineStore } from "./baseline-store.js";
import { PrismaDeviceSyncStore, type DeviceSyncStore } from "./device-sync.js";
import { buildInspectionHospitalScopeIndex, PrismaHospitalSyncStore, type HospitalSyncStore } from "./hospital-sync.js";
import { buildServiceOrderObservation, buildTaskObservation,
  observeCommunication, PrismaCommunicationEventStore, type CommunicationEventStore } from "./communication-event.js";
import { PrismaTaskSyncStore, type TaskSyncStore } from "./task-sync.js";

export type DataOnlyBackfillMode = "dry-run" | "apply";

type DataOnlyBackfillStores = {
  baseline: BaselineStore;
  hospital: HospitalSyncStore;
  device: DeviceSyncStore;
  task: TaskSyncStore;
  communication: CommunicationEventStore;
};

type DataOnlyBackfillInput = {
  prisma: PrismaClient;
  airtable: AirtableIncrementalSource;
  mode: DataOnlyBackfillMode;
  hospitalRecordId?: string;
  now?: Date;
  log?: (line: string) => void;
  stores?: DataOnlyBackfillStores;
};

type SafetyCounts = {
  communicationEvent: number; communicationEventRecipient: number;
  communicationDelivery: number; communicationUnsubscribeGrant: number;
  caseEvent: number; digest: number; accessLink: number;
  notificationBuffer: number; bufferItem: number;
  portalAccessGrant: number; portalRefreshRequest: number; communicationAsset: number;
};

export async function runDataOnlyBackfill(input: DataOnlyBackfillInput) {
  if (input.hospitalRecordId) return runScopedDataOnlyBackfill(input);
  const now = input.now ?? new Date();
  const log = input.log ?? console.info;
  const [contactRecords, hospitalRecords, deviceRecords, serviceOrderRecords,
    inspectionRecords, taskRecords] = await Promise.all([
    input.airtable.fetchAllRecords(AIRTABLE_TABLE_IDS.contacts, CONTACT_FIELD_IDS),
    input.airtable.fetchAllRecords(AIRTABLE_TABLE_IDS.hospitals, HOSPITAL_FIELD_IDS),
    input.airtable.fetchAllRecords(AIRTABLE_TABLE_IDS.devices, DEVICE_FIELD_IDS),
    input.airtable.fetchAllRecords(AIRTABLE_TABLE_IDS.serviceOrders, SERVICE_ORDER_FIELD_IDS),
    input.airtable.fetchAllRecords(AIRTABLE_TABLE_IDS.inspections, INSPECTION_FIELD_IDS),
    input.airtable.fetchAllRecords(AIRTABLE_TABLE_IDS.tasks, TASK_FIELD_IDS),
  ]);
  const contacts = new Map(contactRecords.map(mapContact).map((value) => [value.airtableRecordId, value]));
  const hospitals = hospitalRecords.map(mapHospital);
  const devices = deviceRecords.map(mapDevice);
  const serviceOrders = serviceOrderRecords.map(mapServiceOrder);
  const inspections = inspectionRecords.map(mapInspection);
  const tasks = taskRecords.map(mapTask);
  const inspectionScopes = buildInspectionHospitalScopeIndex(hospitals);
  const inspectionIds = new Set(inspections.map((item) => item.airtableRecordId));
  const missingLinks = tasks.flatMap((task) => task.linkedInspectionRecordIds
    .filter((id) => !inspectionIds.has(id)).map((id) => ({ task: task.airtableRecordId, inspection: id })));
  const scopeAnomalies = inspections.filter((inspection) =>
    (inspectionScopes.get(inspection.airtableRecordId)?.size ?? 0) !== 1).length;
  const durations = inspections.map((item) => item.sourceSnapshot.estimatedDurationSeconds)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const inconsistentInspections = inspections.filter((item) => item.inspectionPerformedAt &&
    /^(DO REALIZACJI|DO WYKONANIA|PLANOWAN|ZAPLANOWAN)/
      .test(item.currentStatus?.trim().toUpperCase() ?? "")).length;
  const existingRows = await Promise.all([
    input.prisma.trackedHospital.findMany({ select: { airtableRecordId: true } }),
    input.prisma.trackedDevice.findMany({ select: { airtableRecordId: true } }),
    input.prisma.trackedCase.findMany({ where: { caseType: CaseType.SERVICE_ORDER }, select: { airtableRecordId: true } }),
    input.prisma.trackedCase.findMany({ where: { caseType: CaseType.INSPECTION }, select: { airtableRecordId: true } }),
    input.prisma.trackedTask.findMany({ select: { airtableRecordId: true } }),
  ]);
  const sourceIdSets = [hospitals, devices, serviceOrders, inspections, tasks]
    .map((items) => new Set(items.map((item) => item.airtableRecordId)));
  const matched = existingRows.map((rows, index) => rows.filter((row) =>
    sourceIdSets[index]!.has(row.airtableRecordId)).length);
  const sourceCounts = [hospitals.length, devices.length, serviceOrders.length, inspections.length, tasks.length];
  const missing = existingRows.map((rows, index) => rows.filter((row) =>
    !sourceIdSets[index]!.has(row.airtableRecordId)).length);
  const report = {
    mode: input.mode,
    airtable: { contacts: contactRecords.length, hospitals: hospitals.length, devices: devices.length,
      serviceOrders: serviceOrders.length, inspections: inspections.length, tasks: tasks.length },
    databaseMatched: { hospitals: matched[0], devices: matched[1], serviceOrders: matched[2],
      inspections: matched[3], tasks: matched[4] },
    willUpdate: { hospitals: matched[0], devices: matched[1], serviceOrders: matched[2],
      inspections: matched[3], tasks: matched[4] },
    willCreate: { hospitals: sourceCounts[0]! - matched[0]!, devices: sourceCounts[1]! - matched[1]!,
      serviceOrders: sourceCounts[2]! - matched[2]!, inspections: sourceCounts[3]! - matched[3]!,
      tasks: sourceCounts[4]! - matched[4]! },
    missingFromAirtable: { hospitals: missing[0], devices: missing[1],
      serviceOrders: missing[2], inspections: missing[3], tasks: missing[4] },
    estimatedDuration: { present: durations.length, missing: inspections.length - durations.length,
      min: durations.length ? Math.min(...durations) : null,
      max: durations.length ? Math.max(...durations) : null },
    hospitalScopeAnomalies: scopeAnomalies,
    missingInspectionLinks: missingLinks,
    inconsistentInspections,
  };
  log(JSON.stringify(report, null, 2));
  if (input.mode === "dry-run") return report;

  const apply = async (prisma: PrismaClient | Prisma.TransactionClient) => {
  const before = await safetyCounts(prisma);
  const baselineStore = input.stores?.baseline ?? new PrismaBaselineStore(prisma);
  for (const item of [...serviceOrders, ...inspections]) {
    const trackedCaseId = await baselineStore.upsertCase(item, now);
    await baselineStore.syncRecipients(trackedCaseId, item.contactRecordIds.map((id) =>
      resolveRecipient(id, contacts.get(id))), now);
  }
  await prisma.trackedCase.updateMany({
    where: { caseType: CaseType.SERVICE_ORDER,
      airtableRecordId: { notIn: serviceOrders.map((item) => item.airtableRecordId) } },
    data: { active: false },
  });
  await prisma.trackedCase.updateMany({
    where: { caseType: CaseType.INSPECTION,
      airtableRecordId: { notIn: inspections.map((item) => item.airtableRecordId) } },
    data: { active: false },
  });
  const hospitalStore = input.stores?.hospital ?? new PrismaHospitalSyncStore(prisma);
  for (const hospital of hospitals) await hospitalStore.upsert(hospital, now);
  await prisma.trackedHospital.updateMany({
    where: { airtableRecordId: { notIn: hospitals.map((item) => item.airtableRecordId) } },
    data: { active: false },
  });
  await hospitalStore.synchronizeInspectionScopes(inspectionScopes, log);
  const deviceStore = input.stores?.device ?? new PrismaDeviceSyncStore(prisma);
  for (const device of devices) await deviceStore.upsert(device, now);
  await prisma.trackedDevice.updateMany({
    where: { airtableRecordId: { notIn: devices.map((item) => item.airtableRecordId) } },
    data: { active: false },
  });
  const taskStore = input.stores?.task ?? new PrismaTaskSyncStore(prisma);
  for (const task of tasks) await taskStore.upsertTask(task, now);
  await prisma.trackedTask.updateMany({
    where: { airtableRecordId: { notIn: tasks.map((item) => item.airtableRecordId) } },
    data: { active: false },
  });

  // Align only communication signatures. allowEvent=false deliberately updates
  // CommunicationCursor without creating historical CommunicationEvent rows.
  const communicationStore = input.stores?.communication ?? new PrismaCommunicationEventStore(prisma);
  for (const item of serviceOrders) await observeCommunication({ store: communicationStore,
    observation: buildServiceOrderObservation(item, now), allowEvent: false, detectedAt: now });
  for (const item of tasks) await observeCommunication({ store: communicationStore,
    observation: buildTaskObservation(item, now), allowEvent: false, detectedAt: now });

  const after = await safetyCounts(prisma);
  const deltas = Object.fromEntries(Object.keys(before).map((key) =>
    [key, after[key as keyof SafetyCounts] - before[key as keyof SafetyCounts]]));
  if (Object.values(deltas).some((delta) => delta !== 0)) {
    throw new Error(`DATA_ONLY_BACKFILL_SAFETY_INVARIANT ${JSON.stringify(deltas)}`);
  }
  log(`DATA_ONLY_BACKFILL_APPLIED safetyDeltas=${JSON.stringify(deltas)}`);
  return { ...report, safetyDeltas: deltas };
  };

  // Airtable reads and analysis happen before this point. Production APPLY puts
  // every database mutation and both invariant snapshots in one transaction;
  // throwing for any write or non-zero forbidden delta rolls the whole phase back.
  if (!input.stores) {
    return input.prisma.$transaction((transaction) => apply(transaction), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 10_000,
      timeout: 120_000,
    });
  }
  return apply(input.prisma);
}

async function runScopedDataOnlyBackfill(input: DataOnlyBackfillInput) {
  const hospitalRecordId = input.hospitalRecordId!;
  const now = input.now ?? new Date();
  const log = input.log ?? console.info;
  const hospitalRecord = await input.airtable.fetchRecord(
    AIRTABLE_TABLE_IDS.hospitals,
    hospitalRecordId,
    HOSPITAL_FIELD_IDS,
  );
  const hospital = mapHospital(hospitalRecord);
  const allHospitalRecords = await input.airtable.fetchAllRecords(
    AIRTABLE_TABLE_IDS.hospitals,
    [HOSPITAL_FIELDS.inspectionLinks],
  );
  const allHospitals = allHospitalRecords
    .filter((record) => record.id !== hospitalRecordId)
    .map(mapHospital)
    .concat(hospital);
  const inspectionScopes = buildInspectionHospitalScopeIndex(allHospitals);
  const hospitalInspectionIds = [...new Set(hospital.linkedInspectionRecordIds)];
  const hospitalInspectionIdSet = new Set(hospitalInspectionIds);

  const [inspectionFetch, allServiceOrderRecords, allTaskRecords, localHospitalInspections] =
    await Promise.all([
      fetchRecordsById(
        input.airtable,
        AIRTABLE_TABLE_IDS.inspections,
        hospitalInspectionIds,
        INSPECTION_FIELD_IDS,
      ),
      input.airtable.fetchAllRecords(AIRTABLE_TABLE_IDS.serviceOrders, SERVICE_ORDER_FIELD_IDS),
      input.airtable.fetchAllRecords(AIRTABLE_TABLE_IDS.tasks, TASK_FIELD_IDS),
      input.prisma.trackedCase.findMany({
        where: { caseType: CaseType.INSPECTION, sourceHospitalRecordId: hospitalRecordId },
        select: { airtableRecordId: true },
      }),
    ]);
  const inspections = inspectionFetch.records.map(mapInspection);
  const serviceOrders = allServiceOrderRecords.map(mapServiceOrder)
    .filter((item) => item.sourceHospitalRecordId === hospitalRecordId);
  const serviceOrderIds = new Set(serviceOrders.map((item) => item.airtableRecordId));
  const tasks = allTaskRecords.map(mapTask).filter((task) =>
    task.sourceHospitalRecordId === hospitalRecordId &&
    task.linkedInspectionRecordIds.some((recordId) => hospitalInspectionIdSet.has(recordId)));
  const expectedDeviceIds = [...new Set([...inspections, ...serviceOrders]
    .flatMap((item) => item.deviceAirtableIds))];
  const deviceFetch = await fetchRecordsById(
    input.airtable,
    AIRTABLE_TABLE_IDS.devices,
    expectedDeviceIds,
    DEVICE_FIELD_IDS,
  );
  const devices = deviceFetch.records.map(mapDevice);
  const contactIds = [...new Set([...inspections, ...serviceOrders]
    .flatMap((item) => item.contactRecordIds))];
  const contactFetch = await fetchRecordsById(
    input.airtable,
    AIRTABLE_TABLE_IDS.contacts,
    contactIds,
    CONTACT_FIELD_IDS,
  );
  const contacts = new Map(contactFetch.records.map(mapContact)
    .map((value) => [value.airtableRecordId, value]));

  const inspectionScopeRecordIds = [...new Set([
    ...hospitalInspectionIds,
    ...localHospitalInspections.map((item) => item.airtableRecordId),
  ])];
  const [existingHospital, existingDevices, existingCases, existingTasks] = await Promise.all([
    input.prisma.trackedHospital.findMany({
      where: { airtableRecordId: hospitalRecordId },
      select: { airtableRecordId: true },
    }),
    input.prisma.trackedDevice.findMany({
      where: { airtableRecordId: { in: expectedDeviceIds } },
      select: { airtableRecordId: true },
    }),
    input.prisma.trackedCase.findMany({
      where: {
        OR: [
          { caseType: CaseType.INSPECTION, airtableRecordId: { in: inspectionScopeRecordIds } },
          { caseType: CaseType.SERVICE_ORDER, airtableRecordId: { in: [...serviceOrderIds] } },
        ],
      },
      select: {
        caseType: true,
        airtableRecordId: true,
        sourceHospitalRecordId: true,
        devices: { select: { deviceAirtableId: true } },
      },
    }),
    input.prisma.trackedTask.findMany({
      where: { airtableRecordId: { in: tasks.map((item) => item.airtableRecordId) } },
      select: { airtableRecordId: true },
    }),
  ]);
  const existingCaseByKey = new Map(existingCases.map((item) =>
    [`${item.caseType}:${item.airtableRecordId}`, item]));
  const existingInspectionIds = new Set(existingCases
    .filter((item) => item.caseType === CaseType.INSPECTION)
    .map((item) => item.airtableRecordId));
  const linkedExistingInspections = hospitalInspectionIds.filter((id) =>
    existingInspectionIds.has(id));
  const linkedInspectionRows = existingCases.filter((item) =>
    item.caseType === CaseType.INSPECTION && hospitalInspectionIdSet.has(item.airtableRecordId));
  const resolution = { unique: 0, missing: 0, ambiguous: 0 };
  for (const recordId of inspectionScopeRecordIds) {
    const hospitalIds = inspectionScopes.get(recordId)?.size ?? 0;
    if (hospitalIds === 1) resolution.unique += 1;
    else if (hospitalIds === 0) resolution.missing += 1;
    else resolution.ambiguous += 1;
  }
  const expectedCases = [...serviceOrders, ...inspections];
  const deviceLinkChanges = expectedCases.flatMap((item) => {
    const stored = existingCaseByKey.get(`${item.caseType}:${item.airtableRecordId}`);
    const current = new Set(stored?.devices.map((device) => device.deviceAirtableId) ?? []);
    const expected = new Set(item.deviceAirtableIds);
    const add = [...expected].filter((id) => !current.has(id));
    const remove = [...current].filter((id) => !expected.has(id));
    return add.length || remove.length
      ? [{ caseType: item.caseType, sourceRecordId: item.airtableRecordId, add, remove }]
      : [];
  });
  const existingIdSets = {
    hospitals: new Set(existingHospital.map((item) => item.airtableRecordId)),
    devices: new Set(existingDevices.map((item) => item.airtableRecordId)),
    serviceOrders: new Set(existingCases.filter((item) => item.caseType === CaseType.SERVICE_ORDER)
      .map((item) => item.airtableRecordId)),
    inspections: existingInspectionIds,
    tasks: new Set(existingTasks.map((item) => item.airtableRecordId)),
  };
  const report = {
    mode: input.mode,
    scope: {
      type: "HOSPITAL" as const,
      hospitalRecordId,
      hospitalName: hospital.name,
      hospitalShortName: hospital.shortName,
    },
    airtable: {
      hospitals: 1,
      hospitalInspectionLinks: hospitalInspectionIds.length,
      inspections: inspections.length,
      serviceOrders: serviceOrders.length,
      devices: devices.length,
      tasks: tasks.length,
      contacts: contacts.size,
    },
    missingFromAirtable: {
      inspections: inspectionFetch.missingRecordIds,
      devices: deviceFetch.missingRecordIds,
      contacts: contactFetch.missingRecordIds,
    },
    inspectionScope: {
      hospitalInspectionLinks: hospitalInspectionIds.length,
      existingInDatabase: linkedExistingInspections.length,
      missingScope: linkedInspectionRows.filter((item) => item.sourceHospitalRecordId === null).length,
      wrongScope: linkedInspectionRows.filter((item) =>
        item.sourceHospitalRecordId !== null &&
        item.sourceHospitalRecordId !== hospitalRecordId).length,
      resolution,
    },
    willUpdate: {
      hospitals: existingIdSets.hospitals.size,
      devices: devices.filter((item) => existingIdSets.devices.has(item.airtableRecordId)).length,
      serviceOrders: serviceOrders.filter((item) =>
        existingIdSets.serviceOrders.has(item.airtableRecordId)).length,
      inspections: inspections.filter((item) =>
        existingIdSets.inspections.has(item.airtableRecordId)).length,
      tasks: tasks.filter((item) => existingIdSets.tasks.has(item.airtableRecordId)).length,
    },
    willCreate: {
      hospitals: existingIdSets.hospitals.size ? 0 : 1,
      devices: devices.filter((item) => !existingIdSets.devices.has(item.airtableRecordId)).length,
      serviceOrders: serviceOrders.filter((item) =>
        !existingIdSets.serviceOrders.has(item.airtableRecordId)).length,
      inspections: inspections.filter((item) =>
        !existingIdSets.inspections.has(item.airtableRecordId)).length,
      tasks: tasks.filter((item) => !existingIdSets.tasks.has(item.airtableRecordId)).length,
    },
    deviceLinksToRepair: {
      cases: deviceLinkChanges.length,
      linksToAdd: deviceLinkChanges.reduce((sum, item) => sum + item.add.length, 0),
      linksToRemove: deviceLinkChanges.reduce((sum, item) => sum + item.remove.length, 0),
      records: deviceLinkChanges,
    },
  };
  log(JSON.stringify(report, null, 2));
  if (input.mode === "dry-run") return report;

  const apply = async (prisma: PrismaClient | Prisma.TransactionClient) => {
    const before = await safetyCounts(prisma);
    const baselineStore = input.stores?.baseline ?? new PrismaBaselineStore(prisma);
    for (const item of expectedCases) {
      const trackedCaseId = await baselineStore.upsertCase(item, now);
      await baselineStore.syncRecipients(
        trackedCaseId,
        item.contactRecordIds.map((id) => resolveRecipient(id, contacts.get(id))),
        now,
      );
    }
    const hospitalStore = input.stores?.hospital ?? new PrismaHospitalSyncStore(prisma);
    await hospitalStore.upsert(hospital, now);
    await hospitalStore.synchronizeInspectionScopes(
      inspectionScopes,
      log,
      inspectionScopeRecordIds,
    );
    const deviceStore = input.stores?.device ?? new PrismaDeviceSyncStore(prisma);
    for (const device of devices) await deviceStore.upsert(device, now);
    const taskStore = input.stores?.task ?? new PrismaTaskSyncStore(prisma);
    for (const task of tasks) await taskStore.upsertTask(task, now);

    const communicationStore = input.stores?.communication ??
      new PrismaCommunicationEventStore(prisma);
    for (const item of serviceOrders) await observeCommunication({
      store: communicationStore,
      observation: buildServiceOrderObservation(item, now),
      allowEvent: false,
      detectedAt: now,
    });
    for (const item of tasks) await observeCommunication({
      store: communicationStore,
      observation: buildTaskObservation(item, now),
      allowEvent: false,
      detectedAt: now,
    });

    const after = await safetyCounts(prisma);
    const deltas = safetyDeltas(before, after);
    if (Object.values(deltas).some((delta) => delta !== 0)) {
      throw new Error(`DATA_ONLY_BACKFILL_SAFETY_INVARIANT ${JSON.stringify(deltas)}`);
    }
    log(
      `DATA_ONLY_BACKFILL_APPLIED scopeHospital=${hospitalRecordId} ` +
      `safetyDeltas=${JSON.stringify(deltas)}`,
    );
    return { ...report, safetyDeltas: deltas };
  };

  if (!input.stores) {
    return input.prisma.$transaction((transaction) => apply(transaction), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 10_000,
      timeout: 120_000,
    });
  }
  return apply(input.prisma);
}

async function fetchRecordsById(
  airtable: AirtableIncrementalSource,
  tableId: string,
  recordIds: readonly string[],
  fieldIds: readonly string[],
): Promise<{ records: AirtableRecord[]; missingRecordIds: string[] }> {
  const records: AirtableRecord[] = [];
  const missingRecordIds: string[] = [];
  for (const recordId of [...new Set(recordIds)]) {
    try {
      records.push(await airtable.fetchRecord(tableId, recordId, fieldIds));
    } catch (error: unknown) {
      if (error instanceof AirtableRequestError && error.httpStatus === 404) {
        missingRecordIds.push(recordId);
        continue;
      }
      throw error;
    }
  }
  return { records, missingRecordIds };
}

function safetyDeltas(before: SafetyCounts, after: SafetyCounts) {
  return Object.fromEntries(Object.keys(before).map((key) =>
    [key, after[key as keyof SafetyCounts] - before[key as keyof SafetyCounts]]));
}

async function safetyCounts(prisma: PrismaClient | Prisma.TransactionClient): Promise<SafetyCounts> {
  const [communicationEvent, communicationEventRecipient, communicationDelivery,
    communicationUnsubscribeGrant, caseEvent, digest, accessLink, notificationBuffer,
    bufferItem, portalAccessGrant, portalRefreshRequest, communicationAsset] = await Promise.all([
    prisma.communicationEvent.count(), prisma.communicationEventRecipient.count(),
    prisma.communicationDelivery.count(), prisma.communicationUnsubscribeGrant.count(),
    prisma.caseEvent.count(), prisma.digest.count(), prisma.accessLink.count(),
    prisma.notificationBuffer.count(), prisma.bufferItem.count(),
    prisma.portalAccessGrant.count(), prisma.portalRefreshRequest.count(),
    prisma.communicationAsset.count(),
  ]);
  return { communicationEvent, communicationEventRecipient, communicationDelivery,
    communicationUnsubscribeGrant, caseEvent, digest, accessLink, notificationBuffer,
    bufferItem, portalAccessGrant, portalRefreshRequest, communicationAsset };
}

async function main() {
  const { mode, hospitalRecordId } = parseDataOnlyBackfillArgs(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL?.trim();
  const baseId = process.env.AIRTABLE_BASE_ID?.trim();
  const personalAccessToken = process.env.AIRTABLE_PAT?.trim();
  if (!databaseUrl || !baseId || !personalAccessToken) {
    throw new Error("DATABASE_URL, AIRTABLE_BASE_ID and AIRTABLE_PAT are required");
  }
  const prisma = createPrismaClient(databaseUrl);
  try {
    await runDataOnlyBackfill({ prisma, mode, ...(hospitalRecordId ? { hospitalRecordId } : {}),
      airtable: new AirtableClient({ baseId, personalAccessToken }) });
  } finally { await prisma.$disconnect(); }
}

export function parseDataOnlyBackfillArgs(args: readonly string[]): {
  mode: DataOnlyBackfillMode;
  hospitalRecordId?: string;
} {
  const apply = args.includes("--apply");
  const dryRun = args.includes("--dry-run");
  if (apply === dryRun) throw new Error("Use exactly one of --dry-run or --apply");
  const hospitalIndexes = args.flatMap((arg, index) => arg === "--hospital" ? [index] : []);
  if (hospitalIndexes.length > 1) throw new Error("Use --hospital at most once");
  const hospitalIndex = hospitalIndexes[0];
  if (hospitalIndex === undefined) return { mode: apply ? "apply" : "dry-run" };
  const hospitalRecordId = args[hospitalIndex + 1]?.trim();
  if (!hospitalRecordId || hospitalRecordId.startsWith("--")) {
    throw new Error("--hospital requires an Airtable Hospital Record ID");
  }
  return { mode: apply ? "apply" : "dry-run", hospitalRecordId };
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/data-only-backfill.js")) {
  void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
