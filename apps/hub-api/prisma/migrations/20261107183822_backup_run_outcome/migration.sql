-- Backup run observability: record each run's outcome (mirrors Restore.exitCode/errorTail).
-- errorTail is scrubbed of credentials/row data before write and exposed to writers only.
ALTER TABLE "Backup" ADD COLUMN "exitCode" INTEGER,
ADD COLUMN "errorTail" TEXT,
ADD COLUMN "durationMs" INTEGER;

ALTER TABLE "VolumeBackup" ADD COLUMN "exitCode" INTEGER,
ADD COLUMN "errorTail" TEXT,
ADD COLUMN "durationMs" INTEGER;
