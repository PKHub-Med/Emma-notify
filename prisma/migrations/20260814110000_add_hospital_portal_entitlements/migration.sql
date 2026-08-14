CREATE TYPE "PortalAccessLevel" AS ENUM ('COMMUNICATION', 'FULL');

CREATE TABLE "HospitalPortalEntitlement" (
    "id" TEXT NOT NULL,
    "sourceHospitalRecordId" TEXT NOT NULL,
    "accessLevel" "PortalAccessLevel" NOT NULL DEFAULT 'COMMUNICATION',
    "enabledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "HospitalPortalEntitlement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "HospitalPortalEntitlement_sourceHospitalRecordId_key"
ON "HospitalPortalEntitlement"("sourceHospitalRecordId");

CREATE INDEX "HospitalPortalEntitlement_accessLevel_idx"
ON "HospitalPortalEntitlement"("accessLevel");
