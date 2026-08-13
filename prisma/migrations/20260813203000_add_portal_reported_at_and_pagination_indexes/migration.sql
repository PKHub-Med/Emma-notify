ALTER TABLE "TrackedCase" ADD COLUMN "reportedAt" TIMESTAMP(3);

ALTER TYPE "SyncEntityType" ADD VALUE IF NOT EXISTS 'SERVICE_ORDER_REPORTED_AT';

DROP INDEX IF EXISTS "TrackedCase_sourceHospitalRecordId_caseType_active_idx";

CREATE INDEX "TrackedCase_sourceHospitalRecordId_caseType_active_sourceModifiedAt_airtableRecordId_idx"
  ON "TrackedCase"("sourceHospitalRecordId", "caseType", "active", "sourceModifiedAt", "airtableRecordId");

CREATE INDEX "TrackedCase_sourceHospitalRecordId_caseType_active_reportedAt_airtableRecordId_idx"
  ON "TrackedCase"("sourceHospitalRecordId", "caseType", "active", "reportedAt", "airtableRecordId");

CREATE INDEX "TrackedTask_linkedInspectionRecordIds_idx"
  ON "TrackedTask" USING GIN ("linkedInspectionRecordIds");

CREATE INDEX "TrackedTask_sourceHospitalRecordId_updatedAt_idx"
  ON "TrackedTask"("sourceHospitalRecordId", "updatedAt");
