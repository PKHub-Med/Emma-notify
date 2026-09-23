ALTER TABLE "TrackedCase"
  ADD COLUMN "repairHeroLabel" TEXT,
  ADD COLUMN "repairHeroDescription" TEXT,
  ADD COLUMN "repairReporter" TEXT,
  ADD COLUMN "repairValidation" TEXT,
  ADD COLUMN "repairOfferNumber" TEXT,
  ADD COLUMN "repairDescription" TEXT;

ALTER TABLE "TrackedDevice"
  ADD COLUMN "emmaDeviceStatus" TEXT,
  ADD COLUMN "productionYear" TEXT,
  ADD COLUMN "commissionedAt" TIMESTAMP(3),
  ADD COLUMN "warrantyUntil" TIMESTAMP(3),
  ADD COLUMN "repairEpc" TEXT;
