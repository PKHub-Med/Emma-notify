ALTER TYPE "CommunicationDeliveryCancelReason" ADD VALUE 'RECIPIENT_OPTED_OUT';

CREATE TABLE "CommunicationUnsubscribeGrant" (
  "id" TEXT NOT NULL,
  "publicId" TEXT NOT NULL,
  "communicationDeliveryId" TEXT NOT NULL,
  "sourceHospitalRecordId" TEXT NOT NULL,
  "normalizedEmail" TEXT,
  "canOptOut" BOOLEAN NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CommunicationUnsubscribeGrant_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CommunicationUnsubscribeGrant_publicId_key" ON "CommunicationUnsubscribeGrant"("publicId");
CREATE UNIQUE INDEX "CommunicationUnsubscribeGrant_communicationDeliveryId_key" ON "CommunicationUnsubscribeGrant"("communicationDeliveryId");
CREATE INDEX "CommunicationUnsubscribeGrant_sourceHospitalRecordId_normalizedEmail_idx" ON "CommunicationUnsubscribeGrant"("sourceHospitalRecordId", "normalizedEmail");
CREATE INDEX "CommunicationUnsubscribeGrant_expiresAt_idx" ON "CommunicationUnsubscribeGrant"("expiresAt");
ALTER TABLE "CommunicationUnsubscribeGrant" ADD CONSTRAINT "CommunicationUnsubscribeGrant_communicationDeliveryId_fkey" FOREIGN KEY ("communicationDeliveryId") REFERENCES "CommunicationDelivery"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "CommunicationOptOut" (
  "id" TEXT NOT NULL,
  "sourceHospitalRecordId" TEXT NOT NULL,
  "normalizedEmail" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CommunicationOptOut_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CommunicationOptOut_sourceHospitalRecordId_normalizedEmail_key" ON "CommunicationOptOut"("sourceHospitalRecordId", "normalizedEmail");
CREATE INDEX "CommunicationOptOut_normalizedEmail_idx" ON "CommunicationOptOut"("normalizedEmail");
