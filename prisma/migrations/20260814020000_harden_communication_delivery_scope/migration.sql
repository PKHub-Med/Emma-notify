ALTER TYPE "CommunicationDeliveryCancelReason" ADD VALUE 'MISSING_HOSPITAL_SCOPE';
ALTER TYPE "CommunicationDeliveryCancelReason" ADD VALUE 'MISSING_HOSPITAL_SCOPE_LEGACY';

ALTER TABLE "WorkerState"
  ADD COLUMN "communicationDeliveryCleanupKey" TEXT,
  ADD COLUMN "communicationDeliveryCleanupAt" TIMESTAMP(3);
