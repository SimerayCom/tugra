-- Coolify hub takeover (lane C): one row per Coolify-known server an agent is installed on over SSH; the state machine is persisted per target.
-- CreateTable
CREATE TABLE "CoolifySshTarget" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "grantId" TEXT,
    "coolifyServerUuid" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PLANNED',
    "code" TEXT,
    "targetTeamId" TEXT,
    "tugraServerId" TEXT,
    "probe" JSONB,
    "hostKeyFp" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CoolifySshTarget_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CoolifySshTarget_serverId_state_idx" ON "CoolifySshTarget"("serverId", "state");

-- CreateIndex
CREATE INDEX "CoolifySshTarget_teamId_idx" ON "CoolifySshTarget"("teamId");

-- CreateIndex
CREATE UNIQUE INDEX "CoolifySshTarget_runId_coolifyServerUuid_key" ON "CoolifySshTarget"("runId", "coolifyServerUuid");

-- AddForeignKey
ALTER TABLE "CoolifySshTarget" ADD CONSTRAINT "CoolifySshTarget_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoolifySshTarget" ADD CONSTRAINT "CoolifySshTarget_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;
