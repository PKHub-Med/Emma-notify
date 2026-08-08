-- CreateTable
CREATE TABLE "AccessLink" (
  "id" TEXT NOT NULL,
  "publicId" TEXT NOT NULL,
  "digestId" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastOpenedAt" TIMESTAMP(3),
  "openCount" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "AccessLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AccessLink_publicId_key" ON "AccessLink"("publicId");
CREATE UNIQUE INDEX "AccessLink_digestId_key" ON "AccessLink"("digestId");
CREATE INDEX "AccessLink_expiresAt_idx" ON "AccessLink"("expiresAt");
CREATE INDEX "AccessLink_revokedAt_idx" ON "AccessLink"("revokedAt");

-- AddForeignKey
ALTER TABLE "AccessLink" ADD CONSTRAINT "AccessLink_digestId_fkey"
FOREIGN KEY ("digestId") REFERENCES "Digest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
