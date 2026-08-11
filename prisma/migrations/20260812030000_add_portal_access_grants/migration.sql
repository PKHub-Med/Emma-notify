-- CreateTable
CREATE TABLE "PortalAccessGrant" (
  "id" TEXT NOT NULL,
  "publicId" TEXT NOT NULL,
  "communicationDeliveryId" TEXT NOT NULL,
  "sourceHospitalRecordId" TEXT NOT NULL,
  "entryContext" JSONB NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "lastOpenedAt" TIMESTAMP(3),
  "openCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PortalAccessGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PortalAccessGrant_publicId_key"
ON "PortalAccessGrant"("publicId");

CREATE UNIQUE INDEX "PortalAccessGrant_communicationDeliveryId_key"
ON "PortalAccessGrant"("communicationDeliveryId");

CREATE INDEX "PortalAccessGrant_sourceHospitalRecordId_idx"
ON "PortalAccessGrant"("sourceHospitalRecordId");

CREATE INDEX "PortalAccessGrant_expiresAt_idx"
ON "PortalAccessGrant"("expiresAt");

CREATE INDEX "PortalAccessGrant_revokedAt_idx"
ON "PortalAccessGrant"("revokedAt");

-- AddForeignKey
ALTER TABLE "PortalAccessGrant"
ADD CONSTRAINT "PortalAccessGrant_communicationDeliveryId_fkey"
FOREIGN KEY ("communicationDeliveryId") REFERENCES "CommunicationDelivery"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
