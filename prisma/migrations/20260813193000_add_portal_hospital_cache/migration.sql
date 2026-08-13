-- Additive portal cache and tenant lookup indexes.
ALTER TYPE "SyncEntityType" ADD VALUE IF NOT EXISTS 'HOSPITAL';

CREATE TABLE "TrackedHospital" (
    "id" TEXT NOT NULL,
    "airtableRecordId" TEXT NOT NULL,
    "shortName" TEXT,
    "name" TEXT,
    "address" TEXT,
    "sourceSnapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TrackedHospital_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TrackedHospital_airtableRecordId_key"
  ON "TrackedHospital"("airtableRecordId");
CREATE INDEX "TrackedCase_sourceHospitalRecordId_caseType_active_idx"
  ON "TrackedCase"("sourceHospitalRecordId", "caseType", "active");
CREATE INDEX "TrackedTask_sourceHospitalRecordId_idx"
  ON "TrackedTask"("sourceHospitalRecordId");
