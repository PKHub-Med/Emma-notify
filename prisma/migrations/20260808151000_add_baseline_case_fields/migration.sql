ALTER TABLE "TrackedCase"
ADD COLUMN "clientOrderNumber" TEXT,
ADD COLUMN "caseSubtype" TEXT,
ADD COLUMN "caseLocation" TEXT,
ADD COLUMN "inspectionDueDate" TIMESTAMP(3),
ADD COLUMN "inspectionDueDateRaw" TEXT,
ADD COLUMN "inspectionScheduledDate" TIMESTAMP(3),
ADD COLUMN "inspectionBookingStatus" TEXT;
