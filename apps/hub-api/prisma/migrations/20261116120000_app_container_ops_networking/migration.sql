ALTER TABLE "Application"
  ADD COLUMN "stopGracePeriodSec" INTEGER,
  ADD COLUMN "drainSec"           INTEGER,
  ADD COLUMN "restartMaxRetries"  INTEGER,
  ADD COLUMN "containerAlias"     TEXT,
  ADD COLUMN "networks"           TEXT[] NOT NULL DEFAULT '{}'::text[];

CREATE UNIQUE INDEX "Application_serverId_containerAlias_key"
  ON "Application"("serverId", "containerAlias");
