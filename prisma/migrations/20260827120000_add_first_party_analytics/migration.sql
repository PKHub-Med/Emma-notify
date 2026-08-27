CREATE TYPE "AnalyticsEventType" AS ENUM (
  'EMAIL_LINK_CLICK',
  'PORTAL_VIEW_CONFIRMED',
  'SCREEN_VIEW',
  'UPGRADE_CLICK'
);

CREATE TABLE "AnalyticsEvent" (
  "id" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "eventType" "AnalyticsEventType" NOT NULL,
  "sessionId" TEXT,
  "portalAccessGrantId" TEXT NOT NULL,
  "communicationDeliveryId" TEXT NOT NULL,
  "sourceHospitalRecordId" TEXT NOT NULL,
  "screen" TEXT,
  "entityType" TEXT,
  "entityRecordId" TEXT,
  "metadata" JSONB,
  CONSTRAINT "AnalyticsEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AnalyticsEvent_createdAt_idx" ON "AnalyticsEvent"("createdAt");
CREATE INDEX "AnalyticsEvent_eventType_createdAt_idx" ON "AnalyticsEvent"("eventType", "createdAt");
CREATE INDEX "AnalyticsEvent_portalAccessGrantId_createdAt_idx" ON "AnalyticsEvent"("portalAccessGrantId", "createdAt");
CREATE INDEX "AnalyticsEvent_communicationDeliveryId_createdAt_idx" ON "AnalyticsEvent"("communicationDeliveryId", "createdAt");
CREATE INDEX "AnalyticsEvent_sourceHospitalRecordId_createdAt_idx" ON "AnalyticsEvent"("sourceHospitalRecordId", "createdAt");
CREATE INDEX "AnalyticsEvent_sessionId_idx" ON "AnalyticsEvent"("sessionId");

ALTER TABLE "AnalyticsEvent" ADD CONSTRAINT "AnalyticsEvent_portalAccessGrantId_fkey"
  FOREIGN KEY ("portalAccessGrantId") REFERENCES "PortalAccessGrant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AnalyticsEvent" ADD CONSTRAINT "AnalyticsEvent_communicationDeliveryId_fkey"
  FOREIGN KEY ("communicationDeliveryId") REFERENCES "CommunicationDelivery"("id") ON DELETE CASCADE ON UPDATE CASCADE;
