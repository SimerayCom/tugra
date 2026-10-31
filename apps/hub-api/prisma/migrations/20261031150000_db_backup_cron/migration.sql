-- Backup schedule: optional 5-field cron (overrides interval) + optional age-based retention (days).
ALTER TABLE "Database" ADD COLUMN "backupCron" TEXT;
ALTER TABLE "Database" ADD COLUMN "backupRetentionDays" INTEGER;
