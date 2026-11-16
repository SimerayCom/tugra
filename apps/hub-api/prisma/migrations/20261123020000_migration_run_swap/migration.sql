-- P7 lane C: the same-host proxy swap record of a swap-proxy migration run (loose runId, no FK).
CREATE TYPE "MigrationRunSwapState" AS ENUM ('PLANNED', 'STOPPING_SOURCE_PROXY', 'STARTING_TARGET_PROXY', 'LIVE', 'REVERSING', 'REVERSED');

CREATE TABLE "MigrationRunSwap" (
  "id"                   TEXT NOT NULL,
  "runId"                TEXT NOT NULL,
  "serverId"             TEXT NOT NULL,
  "state"                "MigrationRunSwapState" NOT NULL DEFAULT 'PLANNED',
  "coolifyProxy"         JSONB NOT NULL,
  "tugraProxyBindBefore" TEXT NOT NULL,
  "stoppedAt"            TIMESTAMP(3),
  "liveAt"               TIMESTAMP(3),
  "reversedAt"           TIMESTAMP(3),
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MigrationRunSwap_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MigrationRunSwap_runId_serverId_key" ON "MigrationRunSwap"("runId", "serverId");
CREATE INDEX "MigrationRunSwap_serverId_idx" ON "MigrationRunSwap"("serverId");
