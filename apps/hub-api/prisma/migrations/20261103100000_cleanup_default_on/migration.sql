-- Turn Docker disk cleanup ON by default for existing servers (Coolify parity). Docker's default json-file
-- driver + untagged build layers grow the host disk without bound, and cleanup shipped default-OFF, so
-- long-running servers creep toward full with nothing trimming them. The prune is now scoped and
-- rollback-safe (dangling image layers + build cache only; named volumes are never touched unless the
-- operator opts in), so enabling it everywhere is safe.
--
-- Opt-out heuristic: only servers still at the shipped default (disabled, with NO cron and NO interval of
-- their own) are touched, so a server the operator deliberately scheduled or left configured is never
-- clobbered. An existing threshold is preserved (COALESCE). New servers are created enabled by the API
-- (ServersService.insertServer / AuthService.provisionLocalServer), so this only backfills legacy rows.
-- Idempotent: after the first run matching rows are enabled, so a re-run is a no-op. The hub schedules
-- these at its next bootstrap.
UPDATE "Server"
SET "cleanupEnabled" = true,
    "cleanupCron" = '0 3 * * *',
    "cleanupThresholdPct" = COALESCE("cleanupThresholdPct", 80)
WHERE "cleanupEnabled" = false
  AND "cleanupCron" IS NULL
  AND "cleanupIntervalHours" IS NULL;
