import "dotenv/config";
import { AIRTABLE_TABLE_IDS, CONTACT_FIELD_IDS, DEVICE_FIELD_IDS, HOSPITAL_FIELD_IDS,
  INSPECTION_FIELD_IDS, SERVICE_ORDER_FIELD_IDS, TASK_FIELD_IDS } from "../airtable/field-ids.js";
import { AirtableClient } from "../airtable/client.js";
import { mapInspection, mapServiceOrder } from "../airtable/mappers.js";
import { mapContact, resolveRecipient } from "../airtable/recipient.js";
import { mapDevice } from "../airtable/device.js";
import { mapHospital } from "../airtable/hospital.js";
import { mapTask } from "../airtable/task.js";
import type { AirtableRecordSource } from "../airtable/types.js";
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

type SafetyCounts = {
  communicationEvent: number; communicationDelivery: number; caseEvent: number;
  digest: number; notificationBuffer: number; bufferItem: number;
  portalAccessGrant: number; communicationAsset: number;
};

export async function runDataOnlyBackfill(input: {
  prisma: PrismaClient;
  airtable: AirtableRecordSource;
  mode: DataOnlyBackfillMode;
  now?: Date;
  log?: (line: string) => void;
  stores?: {
    baseline: BaselineStore;
    hospital: HospitalSyncStore;
    device: DeviceSyncStore;
    task: TaskSyncStore;
    communication: CommunicationEventStore;
  };
}) {
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

async function safetyCounts(prisma: PrismaClient | Prisma.TransactionClient): Promise<SafetyCounts> {
  const [communicationEvent, communicationDelivery, caseEvent, digest,
    notificationBuffer, bufferItem, portalAccessGrant, communicationAsset] = await Promise.all([
    prisma.communicationEvent.count(), prisma.communicationDelivery.count(), prisma.caseEvent.count(),
    prisma.digest.count(), prisma.notificationBuffer.count(), prisma.bufferItem.count(),
    prisma.portalAccessGrant.count(), prisma.communicationAsset.count(),
  ]);
  return { communicationEvent, communicationDelivery, caseEvent, digest,
    notificationBuffer, bufferItem, portalAccessGrant, communicationAsset };
}

async function main() {
  const arg = process.argv.slice(2);
  const mode: DataOnlyBackfillMode = arg.includes("--apply") ? "apply" : "dry-run";
  if (arg.includes("--apply") === arg.includes("--dry-run")) {
    throw new Error("Use exactly one of --dry-run or --apply");
  }
  const databaseUrl = process.env.DATABASE_URL?.trim();
  const baseId = process.env.AIRTABLE_BASE_ID?.trim();
  const personalAccessToken = process.env.AIRTABLE_PAT?.trim();
  if (!databaseUrl || !baseId || !personalAccessToken) {
    throw new Error("DATABASE_URL, AIRTABLE_BASE_ID and AIRTABLE_PAT are required");
  }
  const prisma = createPrismaClient(databaseUrl);
  try {
    await runDataOnlyBackfill({ prisma, mode,
      airtable: new AirtableClient({ baseId, personalAccessToken }) });
  } finally { await prisma.$disconnect(); }
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/data-only-backfill.js")) {
  void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
