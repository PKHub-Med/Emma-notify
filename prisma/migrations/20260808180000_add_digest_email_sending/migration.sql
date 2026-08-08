-- AlterTable
ALTER TABLE "Digest"
ADD COLUMN "actualRecipientEmail" TEXT,
ADD COLUMN "sendAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "nextRetryAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Digest_type_status_nextRetryAt_createdAt_idx"
ON "Digest"("type", "status", "nextRetryAt", "createdAt");
