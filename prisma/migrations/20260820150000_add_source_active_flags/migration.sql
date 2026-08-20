ALTER TABLE "TrackedDevice" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "TrackedTask" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "TrackedHospital" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX "TrackedDevice_active_sourceHospitalRecordId_idx"
ON "TrackedDevice"("active", "sourceHospitalRecordId");

CREATE INDEX "TrackedTask_active_sourceHospitalRecordId_idx"
ON "TrackedTask"("active", "sourceHospitalRecordId");

CREATE INDEX "TrackedHospital_active_airtableRecordId_idx"
ON "TrackedHospital"("active", "airtableRecordId");
