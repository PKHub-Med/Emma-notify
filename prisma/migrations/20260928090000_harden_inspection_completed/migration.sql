ALTER TYPE "CommunicationDeliveryCancelReason" ADD VALUE IF NOT EXISTS 'HISTORICAL_COMPLETED';
ALTER TYPE "CommunicationDeliveryCancelReason" ADD VALUE IF NOT EXISTS 'EMPTY_COMPLETED';

ALTER TABLE "CommunicationDelivery"
ADD COLUMN "logicalDigestKey" TEXT;

CREATE UNIQUE INDEX "CommunicationDelivery_logicalDigestKey_key"
ON "CommunicationDelivery"("logicalDigestKey");
