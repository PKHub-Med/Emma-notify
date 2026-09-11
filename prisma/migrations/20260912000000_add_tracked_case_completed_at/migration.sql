ALTER TABLE "TrackedCase" ADD COLUMN "completedAt" TIMESTAMP(3);

CREATE INDEX "TrackedCase_sourceHospitalRecordId_caseType_active_completedAt_airtableRecordId_idx"
  ON "TrackedCase"("sourceHospitalRecordId", "caseType", "active", "completedAt", "airtableRecordId");
