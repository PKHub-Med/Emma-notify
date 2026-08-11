-- CreateEnum
CREATE TYPE "CommunicationRecipientType" AS ENUM ('CLIENT', 'TIEMED_FALLBACK');

-- CreateEnum
CREATE TYPE "CommunicationRecipientResolutionStatus" AS ENUM (
  'READY',
  'INVALID',
  'FALLBACK',
  'FAILED'
);

-- AlterTable
ALTER TABLE "TrackedCase" ADD COLUMN "sourceHospitalRecordId" TEXT;
ALTER TABLE "TrackedTask" ADD COLUMN "sourceHospitalRecordId" TEXT;
ALTER TABLE "CommunicationEvent" ADD COLUMN "recipientsResolvedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "CommunicationEventRecipient" (
  "id" TEXT NOT NULL,
  "communicationEventId" TEXT NOT NULL,
  "recipientType" "CommunicationRecipientType" NOT NULL,
  "sourceContactRecordId" TEXT,
  "email" TEXT,
  "normalizedEmail" TEXT,
  "recipientKey" TEXT NOT NULL,
  "resolutionStatus" "CommunicationRecipientResolutionStatus" NOT NULL,
  "resolutionReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CommunicationEventRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CommunicationEventRecipient_communicationEventId_normalizedEmail_key"
ON "CommunicationEventRecipient"("communicationEventId", "normalizedEmail");

CREATE UNIQUE INDEX "CommunicationEventRecipient_communicationEventId_recipientKey_key"
ON "CommunicationEventRecipient"("communicationEventId", "recipientKey");

CREATE INDEX "CommunicationEventRecipient_communicationEventId_resolutionStatus_idx"
ON "CommunicationEventRecipient"("communicationEventId", "resolutionStatus");

-- AddForeignKey
ALTER TABLE "CommunicationEventRecipient"
ADD CONSTRAINT "CommunicationEventRecipient_communicationEventId_fkey"
FOREIGN KEY ("communicationEventId") REFERENCES "CommunicationEvent"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
