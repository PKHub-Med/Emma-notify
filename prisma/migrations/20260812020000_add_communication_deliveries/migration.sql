-- CreateEnum
CREATE TYPE "CommunicationDeliveryStatus" AS ENUM (
  'SCHEDULED', 'READY', 'SENDING', 'SENT', 'FAILED', 'CANCELLED'
);

-- CreateEnum
CREATE TYPE "CommunicationDeliveryScheduleReason" AS ENUM (
  'EVENT_DRIVEN', 'REMINDER_0600'
);

-- CreateEnum
CREATE TYPE "CommunicationDeliveryCancelReason" AS ENUM (
  'REMINDER_EXPIRED', 'SOURCE_STATE_CHANGED', 'INVALID_REMINDER_DATE'
);

-- AlterTable
ALTER TABLE "CommunicationEvent"
ADD COLUMN "recipientResolutionAttemptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "nextRecipientResolutionAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "CommunicationDelivery" (
  "id" TEXT NOT NULL,
  "communicationEventId" TEXT NOT NULL,
  "communicationEventRecipientId" TEXT NOT NULL,
  "scenario" "CommunicationScenario" NOT NULL,
  "status" "CommunicationDeliveryStatus" NOT NULL,
  "scheduledFor" TIMESTAMP(3) NOT NULL,
  "readyAt" TIMESTAMP(3),
  "deliveryKey" TEXT NOT NULL,
  "scheduleReason" "CommunicationDeliveryScheduleReason" NOT NULL,
  "cancelReason" "CommunicationDeliveryCancelReason",
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "nextRetryAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "sentAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "resendMessageId" TEXT,
  CONSTRAINT "CommunicationDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CommunicationDelivery_communicationEventRecipientId_key"
ON "CommunicationDelivery"("communicationEventRecipientId");

CREATE UNIQUE INDEX "CommunicationDelivery_deliveryKey_key"
ON "CommunicationDelivery"("deliveryKey");

CREATE UNIQUE INDEX "CommunicationDelivery_communicationEventId_communicationEventRecipientId_key"
ON "CommunicationDelivery"("communicationEventId", "communicationEventRecipientId");

CREATE INDEX "CommunicationDelivery_status_scheduledFor_idx"
ON "CommunicationDelivery"("status", "scheduledFor");

CREATE INDEX "CommunicationDelivery_scenario_status_scheduledFor_idx"
ON "CommunicationDelivery"("scenario", "status", "scheduledFor");

CREATE INDEX "CommunicationEvent_processedAt_recipientsResolvedAt_nextRecipientResolutionAt_idx"
ON "CommunicationEvent"("processedAt", "recipientsResolvedAt", "nextRecipientResolutionAt");

-- AddForeignKey
ALTER TABLE "CommunicationDelivery"
ADD CONSTRAINT "CommunicationDelivery_communicationEventId_fkey"
FOREIGN KEY ("communicationEventId") REFERENCES "CommunicationEvent"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CommunicationDelivery"
ADD CONSTRAINT "CommunicationDelivery_communicationEventRecipientId_fkey"
FOREIGN KEY ("communicationEventRecipientId") REFERENCES "CommunicationEventRecipient"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
