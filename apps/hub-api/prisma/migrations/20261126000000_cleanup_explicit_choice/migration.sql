-- Cleanup is ON by default (Coolify parity). Servers whose cleanup was never configured are switched on here;
-- servers an operator deliberately turned off must stay off. The schema could not tell the two apart, so this
-- adds a column that records an explicit operator choice (set on every saved cleanup config from now on).
ALTER TABLE "Server" ADD COLUMN "cleanupExplicit" BOOLEAN NOT NULL DEFAULT false;

-- Existing rows predate the column, so mark the ones that show evidence of a deliberate setting as explicit:
-- anything configured (cron / interval / threshold), anything that ever ran, or anything an operator saved
-- through the cleanup-config API (audit trail; the bulk entry lists comma-joined server ids in "target").
UPDATE "Server" s
SET "cleanupExplicit" = true
WHERE s."cleanupEnabled" = false
  AND (
    s."cleanupCron" IS NOT NULL
    OR s."cleanupIntervalHours" IS NOT NULL
    OR s."cleanupThresholdPct" IS NOT NULL
    OR s."lastCleanupAt" IS NOT NULL
    OR EXISTS (
      SELECT 1 FROM "AuditLog" a
      WHERE a."action" IN ('server.cleanup.config', 'server.cleanup.config.bulk')
        AND a."target" LIKE '%' || s."id" || '%'
    )
  );

-- Never configured (off, nothing set, never ran, no operator config on record) -> on with the defaults:
-- daily 03:00 plus a run whenever disk usage reaches 80%. The hub registers the schedule within 5 minutes of boot.
UPDATE "Server"
SET "cleanupEnabled" = true,
    "cleanupCron" = '0 3 * * *',
    "cleanupThresholdPct" = 80
WHERE "cleanupEnabled" = false
  AND "cleanupExplicit" = false;
