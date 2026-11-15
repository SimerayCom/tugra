-- Backup cron schedules + age/size retention + per-volume policies. All columns nullable: existing rows unchanged.

-- AlterTable
ALTER TABLE "Application" ADD COLUMN "volumeBackupCron" TEXT;
ALTER TABLE "Application" ADD COLUMN "volumeBackupRetentionDays" INTEGER;
ALTER TABLE "Application" ADD COLUMN "volumeBackupMaxSizeGb" INTEGER;
ALTER TABLE "Database" ADD COLUMN "backupMaxSizeGb" INTEGER;
ALTER TABLE "HubBackupConfig" ADD COLUMN "cron" TEXT;
ALTER TABLE "HubBackupConfig" ADD COLUMN "retentionDays" INTEGER;
ALTER TABLE "HubBackupConfig" ADD COLUMN "maxSizeGb" INTEGER;

-- CreateTable
CREATE TABLE "VolumeBackupPolicy" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "volumeName" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "intervalHours" INTEGER,
    "cron" TEXT,
    "retention" INTEGER,
    "retentionDays" INTEGER,
    "maxSizeGb" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VolumeBackupPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VolumeBackupPolicy_appId_volumeName_key" ON "VolumeBackupPolicy"("appId", "volumeName");

-- CreateIndex
CREATE INDEX "VolumeBackupPolicy_appId_idx" ON "VolumeBackupPolicy"("appId");

-- AddForeignKey
ALTER TABLE "VolumeBackupPolicy" ADD CONSTRAINT "VolumeBackupPolicy_appId_fkey" FOREIGN KEY ("appId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;
