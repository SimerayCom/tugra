-- Coolify hub takeover (lane G): the completeness checklist and the owner-confirmed removal of Coolify's leftovers on a server.
-- CreateTable
CREATE TABLE "CoolifyCleanup" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CHECKING',
    "completeness" JSONB NOT NULL DEFAULT '[]',
    "remnants" JSONB NOT NULL DEFAULT '[]',
    "results" JSONB NOT NULL DEFAULT '[]',
    "confirmedById" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "cleanedAt" TIMESTAMP(3),
    "failureCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CoolifyCleanup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CoolifyCleanup_serverId_createdAt_idx" ON "CoolifyCleanup"("serverId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "CoolifyCleanup_teamId_status_idx" ON "CoolifyCleanup"("teamId", "status");
