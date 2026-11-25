-- Coolify hub takeover (lane F): taking over one server in place (Tugra proxy on a temporary port, port handover, give back to Coolify).
-- CreateTable
CREATE TABLE "CoolifyTakeover" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "sessionId" TEXT,
    "runId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PLANNED',
    "tempPort" INTEGER,
    "plan" JSONB NOT NULL DEFAULT '{}',
    "rollback" JSONB NOT NULL DEFAULT '{}',
    "items" JSONB NOT NULL DEFAULT '[]',
    "giveBackAvailable" BOOLEAN NOT NULL DEFAULT true,
    "failureCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "CoolifyTakeover_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CoolifyTakeover_serverId_createdAt_idx" ON "CoolifyTakeover"("serverId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "CoolifyTakeover_teamId_status_idx" ON "CoolifyTakeover"("teamId", "status");
