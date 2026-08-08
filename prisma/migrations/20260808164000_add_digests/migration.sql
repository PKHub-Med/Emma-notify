-- CreateEnum
CREATE TYPE "DigestType" AS ENUM ('CASE_DIGEST', 'INSPECTION_REMINDER', 'VISIT');

-- CreateEnum
CREATE TYPE "DigestStatus" AS ENUM ('CREATED', 'SENDING', 'SENT', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "Digest" (
  "id" TEXT NOT NULL,
  "type" "DigestType" NOT NULL,
  "status" "DigestStatus" NOT NULL DEFAULT 'CREATED',
  "sourceBufferId" TEXT,
  "intendedRecipientName" TEXT,
  "intendedRecipientEmail" TEXT NOT NULL,
  "normalizedRecipientEmail" TEXT NOT NULL,
  "emailMode" TEXT NOT NULL,
  "itemsCount" INTEGER NOT NULL,
  "subject" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "sendingStartedAt" TIMESTAMP(3),
  "sentAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "lastError" TEXT,
  "resendEmailId" TEXT,
  CONSTRAINT "Digest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DigestItem" (
  "id" TEXT NOT NULL,
  "digestId" TEXT NOT NULL,
  "trackedCaseId" TEXT NOT NULL,
  "snapshot" JSONB NOT NULL,
  "changes" JSONB NOT NULL,
  "firstEventAt" TIMESTAMP(3),
  "lastEventAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DigestItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Digest_sourceBufferId_key" ON "Digest"("sourceBufferId");
CREATE INDEX "Digest_status_createdAt_idx" ON "Digest"("status", "createdAt");
CREATE UNIQUE INDEX "DigestItem_digestId_trackedCaseId_key" ON "DigestItem"("digestId", "trackedCaseId");
CREATE INDEX "DigestItem_trackedCaseId_idx" ON "DigestItem"("trackedCaseId");

-- AddForeignKey
ALTER TABLE "DigestItem" ADD CONSTRAINT "DigestItem_digestId_fkey" FOREIGN KEY ("digestId") REFERENCES "Digest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DigestItem" ADD CONSTRAINT "DigestItem_trackedCaseId_fkey" FOREIGN KEY ("trackedCaseId") REFERENCES "TrackedCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
