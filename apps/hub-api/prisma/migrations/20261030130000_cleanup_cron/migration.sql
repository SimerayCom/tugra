-- Optional cron expression for the per-server Docker cleanup schedule. When set it overrides the plain
-- "every N hours" interval (cleanupIntervalHours). Additive + nullable, so existing servers are unchanged.

-- AlterTable
ALTER TABLE "Server" ADD COLUMN     "cleanupCron" TEXT;
