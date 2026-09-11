CREATE TYPE "PortalRefreshStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED');

CREATE TABLE "PortalRefreshRequest" (
    "id" TEXT NOT NULL,
    "portalAccessGrantId" TEXT NOT NULL,
    "sourceHospitalRecordId" TEXT NOT NULL,
    "communicationDeliveryId" TEXT NOT NULL,
    "accessLevel" "PortalAccessLevel" NOT NULL,
    "contextType" TEXT NOT NULL,
    "contextId" TEXT NOT NULL,
    "serviceOrderRecordIds" JSONB NOT NULL,
    "inspectionRecordIds" JSONB NOT NULL,
    "deviceRecordIds" JSONB NOT NULL,
    "taskRecordIds" JSONB NOT NULL,
    "status" "PortalRefreshStatus" NOT NULL DEFAULT 'PENDING',
    "activeKey" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "errorCode" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "leaseToken" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),

    CONSTRAINT "PortalRefreshRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PortalRefreshRequest_activeKey_key" ON "PortalRefreshRequest"("activeKey");
CREATE INDEX "PortalRefreshRequest_status_requestedAt_idx" ON "PortalRefreshRequest"("status", "requestedAt");
CREATE INDEX "PortalRefreshRequest_status_leaseExpiresAt_requestedAt_idx" ON "PortalRefreshRequest"("status", "leaseExpiresAt", "requestedAt");
CREATE INDEX "PortalRefreshRequest_portalAccessGrantId_requestedAt_idx" ON "PortalRefreshRequest"("portalAccessGrantId", "requestedAt");
CREATE INDEX "PortalRefreshRequest_sourceHospitalRecordId_requestedAt_idx" ON "PortalRefreshRequest"("sourceHospitalRecordId", "requestedAt");

ALTER TABLE "PortalRefreshRequest" ADD CONSTRAINT "PortalRefreshRequest_portalAccessGrantId_fkey"
FOREIGN KEY ("portalAccessGrantId") REFERENCES "PortalAccessGrant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PortalRefreshRequest" ADD CONSTRAINT "PortalRefreshRequest_communicationDeliveryId_fkey"
FOREIGN KEY ("communicationDeliveryId") REFERENCES "CommunicationDelivery"("id") ON DELETE CASCADE ON UPDATE CASCADE;
