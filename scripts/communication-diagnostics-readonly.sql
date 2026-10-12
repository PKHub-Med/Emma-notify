-- READ ONLY. Current pending/blocked communication diagnostics and transition history.
-- Safe for psql: the transaction is explicitly read-only.
BEGIN TRANSACTION READ ONLY;

SELECT
  d."sourceRecordId" AS "taskRecordId",
  d."businessNumber" AS "taskNumber",
  d.scenario,
  d.status,
  d."reasonCode",
  d."reasonOrigin",
  d."missingData",
  d."firstDetectedAt",
  d."lastCheckedAt",
  d."attemptCount",
  d."nextCheckAt",
  d."expiresAt",
  d."communicationEventId",
  d."communicationDeliveryId"
FROM "CommunicationDiagnostic" d
WHERE d."sourceEntityType" = 'TASK'
  AND d.status IN ('PENDING_DATA', 'BLOCKED', 'FAILED')
ORDER BY
  CASE d.status
    WHEN 'BLOCKED' THEN 1
    WHEN 'FAILED' THEN 2
    ELSE 3
  END,
  d."lastCheckedAt" DESC;

-- Set either value to diagnose one task; NULL leaves that filter disabled.
WITH params AS (
  SELECT
    NULL::text AS task_record_id,
    NULL::text AS task_number
)
SELECT
  d."sourceRecordId" AS "taskRecordId",
  d."businessNumber" AS "taskNumber",
  d.scenario,
  h.status,
  h."reasonCode",
  h."reasonOrigin",
  h.details,
  h."occurredAt"
FROM "CommunicationDiagnostic" d
JOIN "CommunicationDiagnosticHistory" h ON h."diagnosticId" = d.id
CROSS JOIN params p
WHERE (p.task_record_id IS NULL OR d."sourceRecordId" = p.task_record_id)
  AND (p.task_number IS NULL OR d."businessNumber" = p.task_number)
ORDER BY h."occurredAt" DESC;

COMMIT;
