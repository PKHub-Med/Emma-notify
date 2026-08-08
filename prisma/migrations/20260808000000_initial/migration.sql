-- CreateEnum
CREATE TYPE "CaseType" AS ENUM ('SERVICE_ORDER', 'INSPECTION');
CREATE TYPE "EventType" AS ENUM ('CASE_CREATED', 'SERVICE_STATUS_CHANGED', 'INSPECTION_STATUS_CHANGED', 'RECIPIENT_CHANGED');
CREATE TYPE "BufferStatus" AS ENUM ('OPEN', 'READY', 'CLOSED', 'CANCELLED');
CREATE TYPE "SyncEntityType" AS ENUM ('SERVICE_ORDER', 'INSPECTION', 'CONTACT');
CREATE TYPE "SyncStatus" AS ENUM ('IDLE', 'RUNNING', 'ERROR');

-- CreateTable
CREATE TABLE "TrackedCase" (
  "id" TEXT NOT NULL,
  "caseType" "CaseType" NOT NULL,
  "airtableRecordId" TEXT NOT NULL,
  "businessNumber" TEXT,
  "hospitalName" TEXT,
  "deviceAirtableId" TEXT,
  "deviceName" TEXT,
  "manufacturer" TEXT,
  "model" TEXT,
  "serialNumber" TEXT,
  "inventoryNumber" TEXT,
  "currentStatus" TEXT,
  "faultDescription" TEXT,
  "sourceSnapshot" JSONB,
  "sourceCreatedAt" TIMESTAMP(3),
  "sourceModifiedAt" TIMESTAMP(3),
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "active" BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT "TrackedCase_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CaseRecipient" (
  "id" TEXT NOT NULL,
  "trackedCaseId" TEXT NOT NULL,
  "airtableContactRecordId" TEXT NOT NULL,
  "name" TEXT,
  "email" TEXT,
  "normalizedEmail" TEXT,
  "eligible" BOOLEAN NOT NULL,
  "eligibilityReason" TEXT,
  "resolutionSource" TEXT NOT NULL DEFAULT 'CONTACT_LINK',
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CaseRecipient_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CaseEvent" (
  "id" TEXT NOT NULL,
  "trackedCaseId" TEXT NOT NULL,
  "eventType" "EventType" NOT NULL,
  "fieldName" TEXT,
  "oldValue" JSONB,
  "newValue" JSONB,
  "triggersNotification" BOOLEAN NOT NULL DEFAULT false,
  "visibleToCustomer" BOOLEAN NOT NULL DEFAULT true,
  "eventFingerprint" TEXT NOT NULL,
  "sourceModifiedAt" TIMESTAMP(3),
  "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CaseEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "NotificationBuffer" (
  "id" TEXT NOT NULL,
  "recipientName" TEXT,
  "recipientEmail" TEXT NOT NULL,
  "normalizedEmail" TEXT NOT NULL,
  "status" "BufferStatus" NOT NULL DEFAULT 'OPEN',
  "firstTriggerAt" TIMESTAMP(3) NOT NULL,
  "lastTriggerAt" TIMESTAMP(3) NOT NULL,
  "sendAfter" TIMESTAMP(3) NOT NULL,
  "activeRecipientKey" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NotificationBuffer_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BufferItem" (
  "id" TEXT NOT NULL,
  "bufferId" TEXT NOT NULL,
  "trackedCaseId" TEXT NOT NULL,
  "firstEventAt" TIMESTAMP(3) NOT NULL,
  "lastEventAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BufferItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SyncState" (
  "id" TEXT NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'AIRTABLE',
  "entityType" "SyncEntityType" NOT NULL,
  "status" "SyncStatus" NOT NULL,
  "lastAttemptAt" TIMESTAMP(3),
  "lastSuccessfulSyncAt" TIMESTAMP(3),
  "baselineCompletedAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SyncState_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WorkerState" (
  "id" TEXT NOT NULL,
  "version" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL,
  "lastHeartbeatAt" TIMESTAMP(3) NOT NULL,
  "lastSyncAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkerState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TrackedCase_caseType_airtableRecordId_key" ON "TrackedCase"("caseType", "airtableRecordId");
CREATE INDEX "TrackedCase_active_lastSeenAt_idx" ON "TrackedCase"("active", "lastSeenAt");
CREATE INDEX "TrackedCase_sourceModifiedAt_idx" ON "TrackedCase"("sourceModifiedAt");
CREATE UNIQUE INDEX "CaseRecipient_trackedCaseId_airtableContactRecordId_key" ON "CaseRecipient"("trackedCaseId", "airtableContactRecordId");
CREATE INDEX "CaseRecipient_normalizedEmail_eligible_idx" ON "CaseRecipient"("normalizedEmail", "eligible");
CREATE UNIQUE INDEX "CaseEvent_eventFingerprint_key" ON "CaseEvent"("eventFingerprint");
CREATE INDEX "CaseEvent_trackedCaseId_detectedAt_idx" ON "CaseEvent"("trackedCaseId", "detectedAt");
CREATE INDEX "CaseEvent_triggersNotification_detectedAt_idx" ON "CaseEvent"("triggersNotification", "detectedAt");
CREATE UNIQUE INDEX "NotificationBuffer_activeRecipientKey_key" ON "NotificationBuffer"("activeRecipientKey");
CREATE INDEX "NotificationBuffer_status_sendAfter_idx" ON "NotificationBuffer"("status", "sendAfter");
CREATE INDEX "NotificationBuffer_normalizedEmail_createdAt_idx" ON "NotificationBuffer"("normalizedEmail", "createdAt");
CREATE UNIQUE INDEX "BufferItem_bufferId_trackedCaseId_key" ON "BufferItem"("bufferId", "trackedCaseId");
CREATE INDEX "BufferItem_trackedCaseId_idx" ON "BufferItem"("trackedCaseId");
CREATE UNIQUE INDEX "SyncState_source_entityType_key" ON "SyncState"("source", "entityType");
CREATE INDEX "SyncState_status_lastAttemptAt_idx" ON "SyncState"("status", "lastAttemptAt");

-- AddForeignKey
ALTER TABLE "CaseRecipient" ADD CONSTRAINT "CaseRecipient_trackedCaseId_fkey" FOREIGN KEY ("trackedCaseId") REFERENCES "TrackedCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CaseEvent" ADD CONSTRAINT "CaseEvent_trackedCaseId_fkey" FOREIGN KEY ("trackedCaseId") REFERENCES "TrackedCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BufferItem" ADD CONSTRAINT "BufferItem_bufferId_fkey" FOREIGN KEY ("bufferId") REFERENCES "NotificationBuffer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BufferItem" ADD CONSTRAINT "BufferItem_trackedCaseId_fkey" FOREIGN KEY ("trackedCaseId") REFERENCES "TrackedCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
