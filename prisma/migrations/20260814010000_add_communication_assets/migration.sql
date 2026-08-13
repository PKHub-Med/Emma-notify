CREATE TYPE "AssetSourceProvider" AS ENUM ('AIRTABLE');
CREATE TYPE "StoredFileKind" AS ENUM ('IMAGE', 'DOCUMENT');
CREATE TYPE "AssetProcessingStatus" AS ENUM (
  'PENDING', 'PROCESSING', 'READY', 'FAILED',
  'REJECTED_TOO_LARGE', 'REJECTED_UNSUPPORTED'
);
CREATE TYPE "CommunicationAssetRole" AS ENUM (
  'PHOTO', 'REPAIR_PROTOCOL', 'DIAGNOSTIC_PROTOCOL',
  'INSPECTION_PROTOCOL', 'OTHER_DOCUMENT'
);

CREATE TABLE "StoredFile" (
  "id" TEXT NOT NULL,
  "sourceProvider" "AssetSourceProvider" NOT NULL DEFAULT 'AIRTABLE',
  "sourceAttachmentId" TEXT NOT NULL,
  "sourceRecordId" TEXT NOT NULL,
  "sourceFieldId" TEXT NOT NULL,
  "sourceEntityType" "CommunicationSourceEntityType" NOT NULL,
  "sourceHospitalRecordId" TEXT NOT NULL,
  "kind" "StoredFileKind" NOT NULL,
  "originalFileName" TEXT NOT NULL,
  "originalMimeType" TEXT NOT NULL,
  "originalSizeBytes" BIGINT,
  "processingStatus" "AssetProcessingStatus" NOT NULL DEFAULT 'PENDING',
  "portalObjectKey" TEXT,
  "thumbnailObjectKey" TEXT,
  "documentObjectKey" TEXT,
  "portalSizeBytes" BIGINT,
  "thumbnailSizeBytes" BIGINT,
  "documentSizeBytes" BIGINT,
  "width" INTEGER,
  "height" INTEGER,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "lastErrorCode" TEXT,
  "processingStartedAt" TIMESTAMP(3),
  "nextAttemptAt" TIMESTAMP(3),
  "processedAt" TIMESTAMP(3),
  "orphanedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StoredFile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CommunicationAsset" (
  "id" TEXT NOT NULL,
  "deliveryId" TEXT NOT NULL,
  "storedFileId" TEXT NOT NULL,
  "role" "CommunicationAssetRole" NOT NULL,
  "displayOrder" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "exposedAt" TIMESTAMP(3),
  CONSTRAINT "CommunicationAsset_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StoredFile_sourceAttachmentId_key" ON "StoredFile"("sourceAttachmentId");
CREATE INDEX "StoredFile_processingStatus_createdAt_idx" ON "StoredFile"("processingStatus", "createdAt");
CREATE INDEX "StoredFile_processingStatus_processingStartedAt_idx" ON "StoredFile"("processingStatus", "processingStartedAt");
CREATE INDEX "StoredFile_processingStatus_nextAttemptAt_idx" ON "StoredFile"("processingStatus", "nextAttemptAt");
CREATE INDEX "StoredFile_sourceHospitalRecordId_idx" ON "StoredFile"("sourceHospitalRecordId");
CREATE INDEX "StoredFile_orphanedAt_idx" ON "StoredFile"("orphanedAt");
CREATE UNIQUE INDEX "CommunicationAsset_deliveryId_storedFileId_role_key" ON "CommunicationAsset"("deliveryId", "storedFileId", "role");
CREATE INDEX "CommunicationAsset_deliveryId_displayOrder_idx" ON "CommunicationAsset"("deliveryId", "displayOrder");
CREATE INDEX "CommunicationAsset_storedFileId_exposedAt_idx" ON "CommunicationAsset"("storedFileId", "exposedAt");

ALTER TABLE "CommunicationAsset" ADD CONSTRAINT "CommunicationAsset_deliveryId_fkey"
FOREIGN KEY ("deliveryId") REFERENCES "CommunicationDelivery"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CommunicationAsset" ADD CONSTRAINT "CommunicationAsset_storedFileId_fkey"
FOREIGN KEY ("storedFileId") REFERENCES "StoredFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
