ALTER TYPE "SyncEntityType" ADD VALUE 'DEVICE';

ALTER TABLE "TrackedCase"
ADD COLUMN "inspectionPerformedAt" TIMESTAMP(3),
ADD COLUMN "inspectionResult" TEXT,
ADD COLUMN "inspectionValidUntil" TIMESTAMP(3);

CREATE TABLE "TrackedDevice" (
  "id" TEXT NOT NULL,
  "airtableRecordId" TEXT NOT NULL,
  "sourceHospitalRecordId" TEXT,
  "name" TEXT,
  "manufacturer" TEXT,
  "model" TEXT,
  "serialNumber" TEXT,
  "inventoryNumber" TEXT,
  "department" TEXT,
  "location" TEXT,
  "deviceStatus" TEXT,
  "sourceCreatedAt" TIMESTAMP(3),
  "sourceModifiedAt" TIMESTAMP(3),
  "sourceSnapshot" JSONB NOT NULL,
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TrackedDevice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TrackedDevice_airtableRecordId_key" ON "TrackedDevice"("airtableRecordId");
CREATE INDEX "TrackedDevice_sourceHospitalRecordId_sourceModifiedAt_sourceCreatedAt_airtableRecordId_idx"
ON "TrackedDevice"("sourceHospitalRecordId", "sourceModifiedAt", "sourceCreatedAt", "airtableRecordId");
CREATE INDEX "TrackedDevice_sourceHospitalRecordId_name_airtableRecordId_idx"
ON "TrackedDevice"("sourceHospitalRecordId", "name", "airtableRecordId");
CREATE INDEX "TrackedDevice_sourceModifiedAt_idx" ON "TrackedDevice"("sourceModifiedAt");
CREATE TABLE "TrackedCaseDevice" (
  "id" TEXT NOT NULL,
  "trackedCaseId" TEXT NOT NULL,
  "deviceAirtableId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TrackedCaseDevice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TrackedCaseDevice_trackedCaseId_deviceAirtableId_key"
ON "TrackedCaseDevice"("trackedCaseId", "deviceAirtableId");
CREATE INDEX "TrackedCaseDevice_trackedCaseId_idx" ON "TrackedCaseDevice"("trackedCaseId");
CREATE INDEX "TrackedCaseDevice_deviceAirtableId_trackedCaseId_idx"
ON "TrackedCaseDevice"("deviceAirtableId", "trackedCaseId");
ALTER TABLE "TrackedCaseDevice" ADD CONSTRAINT "TrackedCaseDevice_trackedCaseId_fkey"
FOREIGN KEY ("trackedCaseId") REFERENCES "TrackedCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "TrackedCaseDevice" ("id", "trackedCaseId", "deviceAirtableId")
SELECT CONCAT('legacy_', MD5(c."id" || ':' || c."deviceAirtableId")),
  c."id", c."deviceAirtableId"
FROM "TrackedCase" c
WHERE NULLIF(BTRIM(COALESCE(c."deviceAirtableId", '')), '') IS NOT NULL
ON CONFLICT ("trackedCaseId", "deviceAirtableId") DO NOTHING;

ALTER TABLE "TrackedCase" DROP COLUMN "deviceAirtableId";
