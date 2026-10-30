-- Scheduled backup of the hub's OWN Postgres (control-plane DB). Two additive tables; reuses BackupStatus.
CREATE TABLE "HubBackupConfig" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "intervalHours" INTEGER NOT NULL DEFAULT 24,
    "retention" INTEGER NOT NULL DEFAULT 7,
    "destinationId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "HubBackupConfig_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "HubBackup" (
    "id" TEXT NOT NULL,
    "status" "BackupStatus" NOT NULL DEFAULT 'PENDING',
    "filename" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "destinationId" TEXT,
    "objectKey" TEXT,
    "sizeBytes" BIGINT,
    "errorTail" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "HubBackup_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "HubBackup_createdAt_idx" ON "HubBackup"("createdAt");
