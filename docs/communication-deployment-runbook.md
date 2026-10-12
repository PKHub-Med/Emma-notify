# Communication reliability deployment runbook

This runbook is intentionally stop-the-world. Do not run the migration while an
old worker can still create communication events.

## Deployment

1. Set `COMMUNICATION_EMAILS_ENABLED=false` and verify the running worker logs
   `COMMUNICATION_EMAILS_STARTUP enabled=false sending=BLOCKED`.
2. Stop every worker instance. Confirm that no old worker remains healthy or is
   restarting automatically.
3. Take and verify a PostgreSQL backup.
4. Apply `20261012130000_add_communication_diagnostics` as an explicit migration
   step. Do not run a data backfill and do not reset communication cursors.
5. Start only the new worker version with `COMMUNICATION_EMAILS_ENABLED=false`.
6. Verify the worker startup log, Prisma connectivity, task synchronization and
   the `COMMUNICATION_CYCLE_SUMMARY` logs.
7. Run `scripts/communication-diagnostics-readonly.sql`. Confirm that historical
   completed tasks are `BLOCKED`/`NOT_ELIGIBLE`, not `READY` or `SCHEDULED`.
8. Check `PENDING_DATA`, hospital-scope conflicts, recipient opt-outs and the
   event/delivery uniqueness counters. Do not replay historical events.
9. Enable email sending only by setting `COMMUNICATION_EMAILS_ENABLED=true` and
   restarting one new worker instance. Verify the startup log before adding more
   instances.
10. Monitor `COMMUNICATION_SENT`, `COMMUNICATION_FAILED`,
    `COMMUNICATION_BLOCKED`, `READY_BUT_HISTORICAL`, provider idempotency and the
    cycle summary.

`PRODUCTION_EMAILS_ENABLED` is a legacy setting and is not a worker kill switch.

## Application rollback

1. Immediately set `COMMUNICATION_EMAILS_ENABLED=false` and stop all new workers.
2. Preserve the migrated schema and diagnostic data. Do not reverse the migration,
   delete diagnostic tables, reset cursors or run a backfill.
3. Deploy the previous application version only after all new workers have
   stopped. Extra nullable columns and diagnostic tables are additive and can be
   ignored by the previous Prisma client.
4. Keep communication emails disabled while the previous version is running.
   The previous version does not understand `PENDING_DATA` recovery.
5. Diagnose and correct the application issue, then repeat the stop-the-world
   deployment steps for the fixed new version.

If an emergency requires the previous version to send mail, that is a separate
production decision and requires an explicit audit of queued deliveries first.
