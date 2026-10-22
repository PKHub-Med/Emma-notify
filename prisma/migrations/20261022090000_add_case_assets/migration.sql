CREATE UNIQUE INDEX "StoredFile_sourceProvider_sourceAttachmentId_key"
ON "StoredFile"("sourceProvider", "sourceAttachmentId");

CREATE TABLE "CaseAsset" (
  "id" TEXT NOT NULL,
  "storedFileId" TEXT NOT NULL,
  "sourceRecordId" TEXT NOT NULL,
  "sourceFieldId" TEXT NOT NULL,
  "sourceEntityType" "CommunicationSourceEntityType" NOT NULL,
  "sourceHospitalRecordId" TEXT NOT NULL,
  "role" "CommunicationAssetRole" NOT NULL,
  "displayOrder" INTEGER NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "removedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CaseAsset_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CaseAsset_sourceEntityType_sourceRecordId_sourceFieldId_storedFileId_key"
ON "CaseAsset"("sourceEntityType", "sourceRecordId", "sourceFieldId", "storedFileId");
CREATE INDEX "CaseAsset_sourceHospitalRecordId_sourceEntityType_sourceRecordId_active_idx"
ON "CaseAsset"("sourceHospitalRecordId", "sourceEntityType", "sourceRecordId", "active");
CREATE INDEX "CaseAsset_storedFileId_active_idx" ON "CaseAsset"("storedFileId", "active");
ALTER TABLE "CaseAsset" ADD CONSTRAINT "CaseAsset_storedFileId_fkey"
FOREIGN KEY ("storedFileId") REFERENCES "StoredFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Preserve already-processed portal assets without inventing deliveries. A later
-- authorized refresh reconciles these links against the current Airtable fields.
INSERT INTO "CaseAsset" (
  "id", "storedFileId", "sourceRecordId", "sourceFieldId", "sourceEntityType",
  "sourceHospitalRecordId", "role", "displayOrder", "active", "firstSeenAt",
  "lastSeenAt", "createdAt", "updatedAt"
)
SELECT DISTINCT ON (
  stored_file."sourceEntityType", stored_file."sourceRecordId",
  stored_file."sourceFieldId", stored_file.id
)
  'legacy_' || md5(
    stored_file."sourceEntityType"::text || ':' || stored_file."sourceRecordId" || ':' ||
    stored_file."sourceFieldId" || ':' || stored_file.id
  ),
  stored_file.id,
  stored_file."sourceRecordId",
  stored_file."sourceFieldId",
  stored_file."sourceEntityType",
  stored_file."sourceHospitalRecordId",
  communication_asset.role,
  communication_asset."displayOrder",
  true,
  communication_asset."createdAt",
  CURRENT_TIMESTAMP,
  communication_asset."createdAt",
  CURRENT_TIMESTAMP
FROM "CommunicationAsset" communication_asset
JOIN "StoredFile" stored_file ON stored_file.id = communication_asset."storedFileId"
WHERE stored_file."sourceEntityType" IN ('SERVICE_ORDER', 'INSPECTION')
ORDER BY stored_file."sourceEntityType", stored_file."sourceRecordId",
  stored_file."sourceFieldId", stored_file.id, communication_asset."createdAt" ASC;
