-- AlterTable
ALTER TABLE "HubBackupConfig" ADD COLUMN "extraDestinationId" TEXT,
ADD COLUMN "drillEnabled" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "HubBackupDrill" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "backupId" TEXT,
    "backupFilename" TEXT,
    "tables" INTEGER,
    "checks" JSONB,
    "errorTail" TEXT,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "HubBackupDrill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HubDeadmanConfig" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "urlEnc" TEXT,
    "intervalMinutes" INTEGER NOT NULL DEFAULT 5,
    "lastTickAt" TIMESTAMP(3),
    "lastPingAt" TIMESTAMP(3),
    "lastOkAt" TIMESTAMP(3),
    "lastError" TEXT,
    "failStreak" INTEGER NOT NULL DEFAULT 0,
    "alertedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HubDeadmanConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MigrationSnapshot" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "destinationId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PLANNED',
    "items" JSONB NOT NULL DEFAULT '[]',
    "note" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "capturedAt" TIMESTAMP(3),
    "restoredAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MigrationSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HubBackupDrill_createdAt_idx" ON "HubBackupDrill"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MigrationSnapshot_runId_key" ON "MigrationSnapshot"("runId");

-- CreateIndex
CREATE INDEX "MigrationSnapshot_teamId_idx" ON "MigrationSnapshot"("teamId");

-- CreateIndex
CREATE INDEX "MigrationSnapshot_status_expiresAt_idx" ON "MigrationSnapshot"("status", "expiresAt");
