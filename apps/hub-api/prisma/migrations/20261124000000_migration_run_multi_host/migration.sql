-- P7 grup-7 contract extension: multi-host runs (serverMap + one lock row per target server), source version, health baseline, campaign label.
-- AlterTable
ALTER TABLE "MigrationRun" ADD COLUMN     "campaign" TEXT,
ADD COLUMN     "serverMap" JSONB,
ADD COLUMN     "sourceBaseline" JSONB,
ADD COLUMN     "sourceVersion" TEXT;

-- CreateTable
CREATE TABLE "MigrationRunServerLock" (
    "serverId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MigrationRunServerLock_pkey" PRIMARY KEY ("serverId")
);

-- CreateIndex
CREATE INDEX "MigrationRunServerLock_runId_idx" ON "MigrationRunServerLock"("runId");

-- CreateIndex
CREATE INDEX "MigrationRun_teamId_campaign_idx" ON "MigrationRun"("teamId", "campaign");

-- AddForeignKey
ALTER TABLE "MigrationRunServerLock" ADD CONSTRAINT "MigrationRunServerLock_runId_fkey" FOREIGN KEY ("runId") REFERENCES "MigrationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: every run that is live today already holds `activeKey = 'srv:<serverId>'` (a single target server), so it gets the
-- matching lock row and the one-live-run-per-server rule keeps holding across the upgrade.
INSERT INTO "MigrationRunServerLock" ("serverId", "runId")
SELECT substring("activeKey" FROM 5), "id" FROM "MigrationRun" WHERE "activeKey" LIKE 'srv:%';
