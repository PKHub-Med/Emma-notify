-- READ ONLY. PostgreSQL diagnostic for the 2026-09-28 INSPECTION_COMPLETED incident.
-- All boundaries are derived in Europe/Warsaw and compared as timestamptz instants.
WITH params AS (
  SELECT
    (DATE '2026-09-28'::timestamp AT TIME ZONE 'Europe/Warsaw') AS from_at,
    ((DATE '2026-09-28' + 1)::timestamp AT TIME ZONE 'Europe/Warsaw') AS to_at
), incident_events AS (
  SELECT
    e.id,
    e."detectedAt",
    CASE
      WHEN e."eventSnapshot"->>'day' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
        THEN LEFT(e."eventSnapshot"->>'day', 10)::date
      ELSE NULL
    END AS business_date
  FROM "CommunicationEvent" e
  CROSS JOIN params p
  WHERE e.scenario = 'INSPECTION_COMPLETED'
    AND e."detectedAt" >= p.from_at
    AND e."detectedAt" < p.to_at
), incident_deliveries AS (
  SELECT
    d.*,
    ie.business_date,
    r."normalizedEmail",
    r.email,
    r."recipientKey"
  FROM incident_events ie
  LEFT JOIN "CommunicationDelivery" d
    ON d."communicationEventId" = ie.id
  LEFT JOIN "CommunicationEventRecipient" r
    ON r.id = d."communicationEventRecipientId"
)
SELECT
  (SELECT COUNT(*) FROM incident_events) AS communication_events_today,
  COUNT(*) FILTER (WHERE id IS NOT NULL AND status = 'READY') AS deliveries_ready,
  COUNT(*) FILTER (WHERE id IS NOT NULL AND status = 'SENDING') AS deliveries_sending,
  COUNT(*) FILTER (WHERE id IS NOT NULL AND status = 'FAILED') AS deliveries_failed,
  COUNT(*) FILTER (WHERE id IS NOT NULL AND status = 'SENT') AS deliveries_sent,
  COUNT(*) FILTER (WHERE id IS NOT NULL AND status = 'CANCELLED') AS deliveries_cancelled,
  MIN(business_date) AS oldest_business_date,
  MAX(business_date) AS newest_business_date,
  COUNT(DISTINCT COALESCE("normalizedEmail", LOWER(email), "recipientKey"))
    FILTER (WHERE id IS NOT NULL) AS unique_recipients,
  COUNT(*) FILTER (
    WHERE id IS NOT NULL
      AND business_date < DATE '2026-09-28'
  ) AS historical_deliveries
FROM incident_deliveries;

-- Read-only breakdown useful for validating the cleanup predicate.
WITH params AS (
  SELECT
    (DATE '2026-09-28'::timestamp AT TIME ZONE 'Europe/Warsaw') AS from_at,
    ((DATE '2026-09-28' + 1)::timestamp AT TIME ZONE 'Europe/Warsaw') AS to_at
)
SELECT
  LEFT(e."eventSnapshot"->>'day', 10) AS business_date,
  d.status,
  COUNT(*) AS deliveries,
  COUNT(DISTINCT COALESCE(r."normalizedEmail", LOWER(r.email), r."recipientKey"))
    AS unique_recipients
FROM "CommunicationEvent" e
JOIN "CommunicationDelivery" d ON d."communicationEventId" = e.id
JOIN "CommunicationEventRecipient" r ON r.id = d."communicationEventRecipientId"
CROSS JOIN params p
WHERE e.scenario = 'INSPECTION_COMPLETED'
  AND e."detectedAt" >= p.from_at
  AND e."detectedAt" < p.to_at
GROUP BY LEFT(e."eventSnapshot"->>'day', 10), d.status
ORDER BY business_date, d.status;
