-- CreateEnum
CREATE TYPE "CommunicationSourceEntityType" AS ENUM ('SERVICE_ORDER', 'TASK');

-- CreateEnum
CREATE TYPE "CommunicationScenario" AS ENUM (
  'REPAIR_RECEIVED',
  'REPAIR_COMPLETED',
  'INSPECTION_DATE_PROPOSED',
  'INSPECTION_DATE_CONFIRMED',
  'INSPECTION_REMINDER',
  'INSPECTION_COMPLETED'
);

-- CreateTable
CREATE TABLE "CommunicationCursor" (
  "id" TEXT NOT NULL,
  "sourceEntityType" "CommunicationSourceEntityType" NOT NULL,
  "sourceRecordId" TEXT NOT NULL,
  "lastSignature" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "firstObservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastObservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CommunicationCursor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommunicationEvent" (
  "id" TEXT NOT NULL,
  "sourceEntityType" "CommunicationSourceEntityType" NOT NULL,
  "sourceRecordId" TEXT NOT NULL,
  "scenario" "CommunicationScenario" NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "eventSnapshot" JSONB NOT NULL,
  "detectedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMP(3),
  CONSTRAINT "CommunicationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CommunicationCursor_sourceEntityType_sourceRecordId_key"
ON "CommunicationCursor"("sourceEntityType", "sourceRecordId");

CREATE INDEX "CommunicationCursor_lastObservedAt_idx"
ON "CommunicationCursor"("lastObservedAt");

CREATE UNIQUE INDEX "CommunicationEvent_fingerprint_key"
ON "CommunicationEvent"("fingerprint");

CREATE INDEX "CommunicationEvent_sourceEntityType_sourceRecordId_detectedAt_idx"
ON "CommunicationEvent"("sourceEntityType", "sourceRecordId", "detectedAt");

CREATE INDEX "CommunicationEvent_scenario_processedAt_detectedAt_idx"
ON "CommunicationEvent"("scenario", "processedAt", "detectedAt");
