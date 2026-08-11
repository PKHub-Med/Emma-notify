-- AlterEnum
ALTER TYPE "SyncEntityType" ADD VALUE 'TASK';

-- AlterTable
ALTER TABLE "TrackedCase"
ADD COLUMN "serviceOrderType" TEXT,
ADD COLUMN "emmaCustomerStatus" TEXT,
ADD COLUMN "emmaMailTemplate" TEXT;

-- CreateTable
CREATE TABLE "TrackedTask" (
  "id" TEXT NOT NULL,
  "airtableRecordId" TEXT NOT NULL,
  "taskNumber" TEXT,
  "day" TEXT,
  "activity" TEXT,
  "completed" BOOLEAN,
  "status" TEXT,
  "emmaCustomerStatus" TEXT,
  "emmaMailTemplate" TEXT,
  "selectedContactRecordIds" JSONB NOT NULL,
  "linkedInspectionRecordIds" JSONB NOT NULL,
  "linkedServiceOrderRecordIds" JSONB NOT NULL,
  "performerRecordIds" JSONB NOT NULL,
  "sourceSnapshot" JSONB NOT NULL,
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TrackedTask_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TrackedTask_airtableRecordId_key"
ON "TrackedTask"("airtableRecordId");

CREATE INDEX "TrackedTask_emmaMailTemplate_idx"
ON "TrackedTask"("emmaMailTemplate");

CREATE INDEX "TrackedTask_lastSeenAt_idx"
ON "TrackedTask"("lastSeenAt");
