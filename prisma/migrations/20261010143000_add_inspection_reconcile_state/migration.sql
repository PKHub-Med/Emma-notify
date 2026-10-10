ALTER TYPE "SyncEntityType" ADD VALUE 'INSPECTION_RECONCILE';

ALTER TABLE "SyncState"
ADD COLUMN "reconcileCursor" TEXT,
ADD COLUMN "leaseToken" TEXT,
ADD COLUMN "leaseExpiresAt" TIMESTAMP(3),
ADD COLUMN "recordsRead" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "recordsChanged" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "recordsUnchanged" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "recordsFailed" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "pagesProcessed" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "SyncState_entityType_status_leaseExpiresAt_idx"
ON "SyncState"("entityType", "status", "leaseExpiresAt");
