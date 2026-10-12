-- Prepared only. Do not apply automatically: production rollout requires an
-- explicit migration step before deploying code that writes diagnostics.

CREATE TYPE "CommunicationDiagnosticStatus" AS ENUM (
  'NOT_ELIGIBLE', 'PENDING_DATA', 'BLOCKED', 'READY', 'SCHEDULED',
  'SENT', 'FAILED', 'CANCELLED'
);

CREATE TYPE "CommunicationDiagnosticOrigin" AS ENUM (
  'AIRTABLE', 'SYNC', 'APPLICATION', 'PROVIDER', 'UNVERIFIED'
);

ALTER TABLE "CommunicationCursor" ADD COLUMN "lastEventRevision" INTEGER;
ALTER TABLE "CommunicationCursor" ADD COLUMN "pendingEventRevision" INTEGER;

-- Preserve the emitted revision for existing cursors. This only records
-- already-existing events; it does not create or replay historical events.
UPDATE "CommunicationCursor" c
SET "lastEventRevision" = emitted.revision
FROM (
  SELECT DISTINCT ON (e."sourceEntityType", e."sourceRecordId")
    e."sourceEntityType",
    e."sourceRecordId",
    CASE
      WHEN e."eventSnapshot"->>'communicationRevision' ~ '^[0-9]+$'
        THEN (e."eventSnapshot"->>'communicationRevision')::integer
      ELSE NULL
    END AS revision
  FROM "CommunicationEvent" e
  ORDER BY e."sourceEntityType", e."sourceRecordId", e."detectedAt" DESC
) emitted
WHERE c."sourceEntityType" = emitted."sourceEntityType"
  AND c."sourceRecordId" = emitted."sourceRecordId";

CREATE TABLE "CommunicationDiagnostic" (
  "id" TEXT NOT NULL,
  "diagnosticKey" TEXT NOT NULL,
  "sourceEntityType" "CommunicationSourceEntityType" NOT NULL,
  "sourceRecordId" TEXT NOT NULL,
  "businessNumber" TEXT,
  "scenario" "CommunicationScenario",
  "scenarioKey" TEXT NOT NULL,
  "status" "CommunicationDiagnosticStatus" NOT NULL,
  "reasonCode" TEXT NOT NULL,
  "reasonOrigin" "CommunicationDiagnosticOrigin" NOT NULL,
  "missingData" JSONB,
  "firstDetectedAt" TIMESTAMP(3) NOT NULL,
  "lastCheckedAt" TIMESTAMP(3) NOT NULL,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "nextCheckAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  "terminalAt" TIMESTAMP(3),
  "communicationEventId" TEXT,
  "communicationDeliveryId" TEXT,
  "retentionUntil" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CommunicationDiagnostic_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CommunicationDiagnosticHistory" (
  "id" TEXT NOT NULL,
  "diagnosticId" TEXT NOT NULL,
  "status" "CommunicationDiagnosticStatus" NOT NULL,
  "reasonCode" TEXT NOT NULL,
  "reasonOrigin" "CommunicationDiagnosticOrigin" NOT NULL,
  "details" JSONB,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "retentionUntil" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CommunicationDiagnosticHistory_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CommunicationDiagnostic_diagnosticKey_key"
ON "CommunicationDiagnostic"("diagnosticKey");
CREATE UNIQUE INDEX "CommunicationDiagnostic_sourceEntityType_sourceRecordId_scenarioKey_key"
ON "CommunicationDiagnostic"("sourceEntityType", "sourceRecordId", "scenarioKey");
CREATE INDEX "CommunicationDiagnostic_status_nextCheckAt_idx"
ON "CommunicationDiagnostic"("status", "nextCheckAt");
CREATE INDEX "CommunicationDiagnostic_sourceRecordId_lastCheckedAt_idx"
ON "CommunicationDiagnostic"("sourceRecordId", "lastCheckedAt");
CREATE INDEX "CommunicationDiagnostic_businessNumber_lastCheckedAt_idx"
ON "CommunicationDiagnostic"("businessNumber", "lastCheckedAt");
CREATE INDEX "CommunicationDiagnostic_communicationEventId_idx"
ON "CommunicationDiagnostic"("communicationEventId");
CREATE INDEX "CommunicationDiagnostic_communicationDeliveryId_idx"
ON "CommunicationDiagnostic"("communicationDeliveryId");
CREATE INDEX "CommunicationDiagnostic_retentionUntil_idx"
ON "CommunicationDiagnostic"("retentionUntil");
CREATE INDEX "CommunicationDiagnosticHistory_diagnosticId_occurredAt_idx"
ON "CommunicationDiagnosticHistory"("diagnosticId", "occurredAt");
CREATE INDEX "CommunicationDiagnosticHistory_status_occurredAt_idx"
ON "CommunicationDiagnosticHistory"("status", "occurredAt");
CREATE INDEX "CommunicationDiagnosticHistory_retentionUntil_idx"
ON "CommunicationDiagnosticHistory"("retentionUntil");

ALTER TABLE "CommunicationDiagnosticHistory"
ADD CONSTRAINT "CommunicationDiagnosticHistory_diagnosticId_fkey"
FOREIGN KEY ("diagnosticId") REFERENCES "CommunicationDiagnostic"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
