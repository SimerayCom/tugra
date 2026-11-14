-- Deploy lease / recovery columns (ACTION-LIST #2): who drives a RUNNING deploy, where it is, and what the
-- agent was told, so a restarted hub can ADOPT the deploy instead of blindly failing it.
-- All nullable: NULL = legacy row, pre-dispatch phase, swarm/build-server/rollback path, or an old agent.
ALTER TABLE "Deployment"
  ADD COLUMN "ownerId" TEXT,
  ADD COLUMN "heartbeatAt" TIMESTAMP(3),
  ADD COLUMN "phase" TEXT,
  ADD COLUMN "agentReqId" TEXT,
  ADD COLUMN "agentServerId" TEXT,
  ADD COLUMN "deadlineAt" TIMESTAMP(3),
  ADD COLUMN "dispatchPlan" JSONB;

-- Recovery scans: RUNNING rows by phase / server.
CREATE INDEX "Deployment_status_phase_idx" ON "Deployment"("status", "phase");
CREATE INDEX "Deployment_agentServerId_idx" ON "Deployment"("agentServerId");
