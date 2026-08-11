-- AlterEnum
ALTER TYPE "CommunicationDeliveryCancelReason" ADD VALUE 'PRE_ACTIVATION';

-- AlterTable
ALTER TABLE "CommunicationDelivery"
ADD COLUMN "sendingStartedAt" TIMESTAMP(3),
ADD COLUMN "preparedAt" TIMESTAMP(3),
ADD COLUMN "sendSnapshot" JSONB,
ADD COLUMN "emailMode" TEXT,
ADD COLUMN "actualRecipientEmail" TEXT,
ADD COLUMN "lastError" TEXT;
