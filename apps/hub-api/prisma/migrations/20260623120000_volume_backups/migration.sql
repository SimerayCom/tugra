-- Volume backups: back up an app's named Docker volumes to a destination.
CREATE TABLE "VolumeBackup" (
  "id" TEXT NOT NULL,
  "appId" TEXT NOT NULL,
  "volumeName" TEXT NOT NULL,
  "status" "BackupStatus" NOT NULL DEFAULT 'PENDING',
  "filename" TEXT NOT NULL,
  "path" TEXT NOT NULL,
  "destinationId" TEXT,
  "objectKey" TEXT,
  "sizeBytes" BIGINT,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "VolumeBackup_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "VolumeBackup_appId_idx" ON "VolumeBackup"("appId");

ALTER TABLE "VolumeBackup"
  ADD CONSTRAINT "VolumeBackup_appId_fkey"
  FOREIGN KEY ("appId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Application" ADD COLUMN "volumeBackupEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Application" ADD COLUMN "volumeBackupIntervalHours" INTEGER;
ALTER TABLE "Application" ADD COLUMN "volumeBackupRetention" INTEGER NOT NULL DEFAULT 7;
ALTER TABLE "Application" ADD COLUMN "volumeBackupDestinationId" TEXT;
