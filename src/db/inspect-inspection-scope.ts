import "dotenv/config";
import { AirtableClient } from "../airtable/client.js";
import {
  AIRTABLE_TABLE_IDS,
  HOSPITAL_FIELD_IDS,
  HOSPITAL_FIELDS,
  INSPECTION_FIELD_IDS,
} from "../airtable/field-ids.js";
import { mapHospital } from "../airtable/hospital.js";
import { mapInspection } from "../airtable/mappers.js";
import { CaseType } from "../generated/prisma/enums.js";
import { createPrismaClient } from "./prisma.js";

async function main(): Promise<void> {
  const sourceRecordId = (
    process.env.SOURCE_RECORD_ID ?? process.argv[2] ?? ""
  ).trim();
  if (!sourceRecordId) {
    throw new Error(
      "Usage: npm run db:inspect-inspection-scope -- recInspectionId",
    );
  }
  const databaseUrl = process.env.DATABASE_URL?.trim();
  const baseId = process.env.AIRTABLE_BASE_ID?.trim();
  const personalAccessToken = process.env.AIRTABLE_PAT?.trim();
  if (!databaseUrl || !baseId || !personalAccessToken) {
    throw new Error("DATABASE_URL, AIRTABLE_BASE_ID and AIRTABLE_PAT are required");
  }

  const prisma = createPrismaClient(databaseUrl);
  const airtable = new AirtableClient({ baseId, personalAccessToken });
  try {
    const [trackedCase, inspectionRecord, hospitalRecords] = await Promise.all([
      prisma.trackedCase.findUnique({
        where: {
          caseType_airtableRecordId: {
            caseType: CaseType.INSPECTION,
            airtableRecordId: sourceRecordId,
          },
        },
        select: {
          id: true,
          sourceHospitalRecordId: true,
          active: true,
          inspectionDueDate: true,
          inspectionScheduledDate: true,
          inspectionPerformedAt: true,
          currentStatus: true,
          devices: {
            orderBy: { deviceAirtableId: "asc" },
            select: { deviceAirtableId: true },
          },
        },
      }),
      airtable.fetchRecord(
        AIRTABLE_TABLE_IDS.inspections,
        sourceRecordId,
        INSPECTION_FIELD_IDS,
      ),
      airtable.fetchAllRecords(
        AIRTABLE_TABLE_IDS.hospitals,
        HOSPITAL_FIELD_IDS,
      ),
    ]);
    const inspection = mapInspection(inspectionRecord);
    const hospitals = hospitalRecords
      .map(mapHospital)
      .filter((hospital) => hospital.linkedInspectionRecordIds.includes(sourceRecordId))
      .map((hospital) => ({
        airtableRecordId: hospital.airtableRecordId,
        shortName: hospital.shortName,
        name: hospital.name,
      }))
      .sort((left, right) => left.airtableRecordId.localeCompare(right.airtableRecordId));

    console.info(JSON.stringify({
      mode: "READ_ONLY",
      inspectionAirtableRecordId: sourceRecordId,
      existsInTrackedCase: trackedCase !== null,
      sourceHospitalRecordId: trackedCase?.sourceHospitalRecordId ?? null,
      hospitalsFromHospitalInspectionLinks: hospitals,
      hospitalScopeResolution: hospitals.length === 1
        ? { outcome: "UNIQUE", sourceHospitalRecordId: hospitals[0]!.airtableRecordId }
        : hospitals.length === 0
          ? { outcome: "MISSING", sourceHospitalRecordId: null }
          : { outcome: "AMBIGUOUS", sourceHospitalRecordId: null },
      deviceRecordIds: inspection.deviceAirtableIds,
      trackedCaseDevice: trackedCase?.devices.map((item) => item.deviceAirtableId) ?? [],
      active: trackedCase?.active ?? null,
      inspectionDates: {
        airtable: {
          dueAt: inspection.inspectionDueDate,
          scheduledAt: inspection.inspectionScheduledDate,
          performedAt: inspection.inspectionPerformedAt,
        },
        local: {
          dueAt: trackedCase?.inspectionDueDate ?? null,
          scheduledAt: trackedCase?.inspectionScheduledDate ?? null,
          performedAt: trackedCase?.inspectionPerformedAt ?? null,
        },
      },
      currentStatus: {
        airtable: inspection.currentStatus,
        local: trackedCase?.currentStatus ?? null,
      },
    }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
