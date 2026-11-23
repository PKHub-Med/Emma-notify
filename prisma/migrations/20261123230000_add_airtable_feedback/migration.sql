-- Additive only: communication write-back outbox and cursor.
-- Safe for the previous application version, which ignores these tables.

CREATE TABLE "AirtableFeedbackRecord" (
  "id" TEXT NOT NULL,
  "tableId" TEXT NOT NULL,
  "recordId" TEXT NOT NULL,
  "pending" BOOLEAN NOT NULL DEFAULT true,
  "dirtyAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "fingerprint" TEXT,
  "lastWrittenAt" TIMESTAMP(3),
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AirtableFeedbackRecord_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AirtableFeedbackRecord_tableId_recordId_key"
  ON "AirtableFeedbackRecord"("tableId", "recordId");

CREATE INDEX "AirtableFeedbackRecord_pending_nextAttemptAt_dirtyAt_idx"
  ON "AirtableFeedbackRecord"("pending", "nextAttemptAt", "dirtyAt");

CREATE TABLE "AirtableFeedbackState" (
  "id" TEXT NOT NULL,
  "cursorAt" TIMESTAMP(3) NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AirtableFeedbackState_pkey" PRIMARY KEY ("id")
);
