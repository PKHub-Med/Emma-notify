# Attachment synchronization runbook

## What changed

Portal attachment discovery is driven by an authorized portal refresh, not by a
communication scenario. `CaseAsset` records describe the current Airtable
attachment set for a repair or inspection. `CommunicationAsset` remains intact
for the existing email preflight and is never fabricated by the refresh path.

An Airtable URL is resolved immediately before processing and is never persisted.
Objects stay private and portal access still uses short-lived signed URLs.

## Existing `ASSET_PROCESSING_ERROR`

The historical error code is deliberately lossy: any exception whose message was
not an all-uppercase symbolic code was collapsed to `ASSET_PROCESSING_ERROR`.
That includes AWS SDK/S3 errors. Since both image and PDF jobs failed, their
shared download/storage/database stages are candidates; the saved code alone
does not prove which one failed. Do not claim a root cause without stage logs or
an approved probe.

New logs identify `AIRTABLE_FETCH`, `ATTACHMENT_DOWNLOAD`, `IMAGE_TRANSFORM`,
`STORAGE_UPLOAD`, `DATABASE_UPDATE`, `ACCESS_SCOPE`, `RETRY_SCHEDULED`, and
`RETRY_EXHAUSTED`. They contain IDs, kind, attempt count, duration, safe error
category, optional HTTP status and retryability, but never temporary URLs,
credentials, headers, document contents or raw exceptions.

The configured SDK shape matches current Railway Buckets: region `auto`, the
base HTTPS endpoint, and virtual-hosted addressing (`FORCE_PATH_STYLE=false`).
Older buckets can require path-style addressing; use exactly the URL style shown
in that bucket's Credentials tab. A wrong style or mismatched bucket credentials
would now be visible as `STORAGE_UPLOAD`, but cannot be confirmed from the six
historical generic errors.

## Deployment order

1. Back up PostgreSQL and deploy migration `20261022090000_add_case_assets`.
2. Deploy API and worker from the same release. Do not enable a production probe.
3. Confirm processor and refresh logs have no scope or storage errors.
4. Open a test portal and run **Aktualizuj dane**. Confirm its authorized current
   and historical cases gain attachments and no communication delivery is created.
5. Roll out normally. The refresh is the controlled backfill mechanism; there is
   no global automatic historical reset.

The migration adds `CaseAsset`, adds the source-aware `StoredFile` uniqueness
index `(sourceProvider, sourceAttachmentId)` while retaining the legacy index
for rollback compatibility, and seeds links for existing
`CommunicationAsset` rows so current portal files do not disappear before the
first refresh. It does not alter/reset deliveries or send communication.

## Approved integration probe

After explicit approval, choose one non-sensitive attachment and set the four
`ASSET_PROBE_*` selectors plus `ASSET_PROBE_APPROVED=true`, then run:

`npm run assets:integration-probe`

The probe fetches the selected Airtable attachment, transforms a small image (or
keeps a document unchanged), uploads a random probe object, verifies it with
HEAD, and deletes only that probe object. It does not touch `StoredFile`,
`CaseAsset`, `CommunicationDelivery`, or email state.

## Controlled recovery of exhausted files

Fix and verify the underlying cause first. Then set
`ASSET_RETRY_STORED_FILE_IDS` to an explicit comma-separated list of at most 25
IDs, set `ASSET_RETRY_APPROVED=true`, and run:

`npm run assets:retry-selected`

Only terminal `FAILED` rows (`nextAttemptAt IS NULL`) in that list are moved back
to `PENDING`. No other historical failures are reset. Monitor stage logs and stop
if the same error category returns. Normal processing remains bounded to four
attempts with backoff and row-claim concurrency protection.
