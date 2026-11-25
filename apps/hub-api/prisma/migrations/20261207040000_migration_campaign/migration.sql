-- Coolify hub takeover (lane E): a campaign of guided runs, one per source server, in waves (mixed placement).
-- CreateTable
CREATE TABLE "MigrationCampaign" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "sessionId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "plan" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MigrationCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MigrationCampaign_teamId_createdAt_idx" ON "MigrationCampaign"("teamId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "MigrationCampaign_teamId_label_key" ON "MigrationCampaign"("teamId", "label");
