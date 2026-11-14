-- Fleet rollouts: canary → waves → health gate → halt/resume. Additive.
CREATE TYPE "RolloutStatus" AS ENUM ('RUNNING', 'HALTED', 'ROLLING_BACK', 'COMPLETED', 'ROLLED_BACK', 'ROLLBACK_FAILED', 'CANCELLED');
CREATE TYPE "RolloutTargetStatus" AS ENUM ('PENDING', 'DEPLOYING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'SKIPPED', 'REVERTING', 'ROLLED_BACK', 'ROLLBACK_FAILED');

CREATE TABLE "Rollout" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "name" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'app_deploy',
    "status" "RolloutStatus" NOT NULL DEFAULT 'RUNNING',
    "haltReason" TEXT,
    "haltDetail" JSONB,
    "config" JSONB NOT NULL,
    "currentWave" INTEGER NOT NULL DEFAULT 0,
    "waveCount" INTEGER NOT NULL,
    "waveStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "bakeUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Rollout_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RolloutTarget" (
    "id" TEXT NOT NULL,
    "rolloutId" TEXT NOT NULL,
    "wave" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'app_deploy',
    "resourceId" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "status" "RolloutTargetStatus" NOT NULL DEFAULT 'PENDING',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "baselineDeploymentId" TEXT,
    "deploymentId" TEXT,
    "outcome" TEXT,
    "detail" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "dispatchedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    CONSTRAINT "RolloutTarget_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Rollout_teamId_createdAt_idx" ON "Rollout"("teamId", "createdAt");
CREATE INDEX "Rollout_status_idx" ON "Rollout"("status");
CREATE UNIQUE INDEX "RolloutTarget_rolloutId_resourceId_key" ON "RolloutTarget"("rolloutId", "resourceId");
CREATE INDEX "RolloutTarget_rolloutId_wave_idx" ON "RolloutTarget"("rolloutId", "wave");
-- One LIVE rollout per app (Prisma cannot model a partial index).
CREATE UNIQUE INDEX "rollout_target_one_active_per_resource" ON "RolloutTarget"("kind", "resourceId") WHERE "active";

ALTER TABLE "Rollout" ADD CONSTRAINT "Rollout_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RolloutTarget" ADD CONSTRAINT "RolloutTarget_rolloutId_fkey" FOREIGN KEY ("rolloutId") REFERENCES "Rollout"("id") ON DELETE CASCADE ON UPDATE CASCADE;
