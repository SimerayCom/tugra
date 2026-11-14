-- Fleet rollback bookkeeping on rollout targets. Additive.
ALTER TABLE "RolloutTarget" ADD COLUMN "rollbackDeploymentId" TEXT;
ALTER TABLE "RolloutTarget" ADD COLUMN "rollbackAttempt" INTEGER NOT NULL DEFAULT 0;
