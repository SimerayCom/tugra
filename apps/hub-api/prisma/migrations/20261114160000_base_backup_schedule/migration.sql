-- Scheduled physical base backups (the PITR anchors). Additive, default off.
ALTER TABLE "Database" ADD COLUMN "baseBackupEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Database" ADD COLUMN "baseBackupIntervalHours" INTEGER;
ALTER TABLE "Database" ADD COLUMN "baseBackupCron" TEXT;
