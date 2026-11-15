-- App move to another server: a persisted job table (loose appId, no FK) + two additive nullable columns.
CREATE TYPE "AppMovePhase" AS ENUM ('QUEUED','PRECHECK','STOPPING_SOURCE','TRANSFERRING','DEPLOYING','FINALIZING','COMPLETED','ROLLING_BACK','ROLLED_BACK','FAILED');

CREATE TABLE "AppMove" (
  "id" TEXT NOT NULL,
  "appId" TEXT NOT NULL,
  "appName" TEXT NOT NULL,
  "teamId" TEXT NOT NULL,
  "requestedBy" TEXT NOT NULL,
  "sourceServerId" TEXT NOT NULL,
  "targetServerId" TEXT NOT NULL,
  "phase" "AppMovePhase" NOT NULL DEFAULT 'QUEUED',
  "prevStatus" "AppStatus" NOT NULL,
  "plan" JSONB NOT NULL,
  "acks" JSONB NOT NULL DEFAULT '{}',
  "repointDns" BOOLEAN NOT NULL DEFAULT false,
  "retainDays" INTEGER NOT NULL DEFAULT 7,
  "volumes" JSONB NOT NULL DEFAULT '[]',
  "snapshotBefore" JSONB,
  "deploymentId" TEXT,
  "warnings" JSONB NOT NULL DEFAULT '[]',
  "failureReason" TEXT,
  "failurePhase" "AppMovePhase",
  "logTail" TEXT,
  "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
  "ownerId" TEXT,
  "heartbeatAt" TIMESTAMP(3),
  "deadlineAt" TIMESTAMP(3),
  "startedAt" TIMESTAMP(3),
  "cutoverAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "archiveUntil" TIMESTAMP(3),
  "sourcePurgedAt" TIMESTAMP(3),
  "targetPurgedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AppMove_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AppMove_appId_createdAt_idx" ON "AppMove"("appId", "createdAt" DESC);
CREATE INDEX "AppMove_phase_idx" ON "AppMove"("phase");
CREATE INDEX "AppMove_sourceServerId_idx" ON "AppMove"("sourceServerId");
CREATE INDEX "AppMove_targetServerId_idx" ON "AppMove"("targetServerId");

-- DB backstop for "one live move per app" (Prisma cannot model a partial index).
CREATE UNIQUE INDEX "AppMove_one_active_per_app" ON "AppMove"("appId") WHERE "phase" NOT IN ('COMPLETED','ROLLED_BACK','FAILED');

ALTER TABLE "Deployment" ADD COLUMN "runServerId" TEXT;
ALTER TABLE "VolumeBackup" ADD COLUMN "hostServerId" TEXT;
