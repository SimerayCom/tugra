-- Server prices, saved "before" bills and provider rescales (cost and rightsizing).
ALTER TABLE "Server" ADD COLUMN "cloudHint" TEXT;

CREATE TABLE "ServerCost" (
    "serverId" TEXT NOT NULL,
    "monthlyCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "source" TEXT NOT NULL,
    "provider" TEXT,
    "planSlug" TEXT,
    "location" TEXT,
    "syncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServerCost_pkey" PRIMARY KEY ("serverId")
);

CREATE TABLE "CostBaseline" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "monthlyCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "lines" JSONB NOT NULL DEFAULT '[]',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CostBaseline_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ServerRescale" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "fromPlan" TEXT NOT NULL,
    "toPlan" TEXT NOT NULL,
    "upgradeDisk" BOOLEAN NOT NULL DEFAULT false,
    "phase" TEXT NOT NULL DEFAULT 'SHUTTING_DOWN',
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ServerRescale_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CostBaseline_teamId_createdAt_idx" ON "CostBaseline"("teamId", "createdAt");
CREATE INDEX "ServerRescale_serverId_startedAt_idx" ON "ServerRescale"("serverId", "startedAt");

-- One rescale at a time per server.
CREATE UNIQUE INDEX "server_rescale_one_active_per_server" ON "ServerRescale"("serverId") WHERE "phase" NOT IN ('DONE', 'FAILED');

ALTER TABLE "ServerCost" ADD CONSTRAINT "ServerCost_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CostBaseline" ADD CONSTRAINT "CostBaseline_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServerRescale" ADD CONSTRAINT "ServerRescale_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;
