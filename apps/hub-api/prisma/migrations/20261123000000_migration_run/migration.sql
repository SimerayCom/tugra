-- P7 one-click migration orchestrator: MigrationRun (+ steps, append-only events). Core models only; lanes B/C add their own tables.
-- CreateEnum
CREATE TYPE "MigrationRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'WAITING', 'PAUSED', 'ABORTING', 'ABORTED', 'ROLLING_BACK', 'ROLLED_BACK', 'REVERSING', 'REVERSED', 'COMPLETED', 'FAILED', 'DRY_RUN_DONE');

-- CreateEnum
CREATE TYPE "MigrationRunStepStatus" AS ENUM ('PENDING', 'RUNNING', 'WAITING_OPERATOR', 'WAITING_APPROVAL', 'WAITING_TIMER', 'PASSED', 'FAILED', 'SKIPPED', 'COMPENSATED');

-- CreateTable
CREATE TABLE "MigrationRun" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "targetServerId" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "sourceHost" TEXT,
    "sessionId" TEXT,
    "opId" TEXT,
    "opHistory" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "planHash" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'copy',
    "topology" TEXT NOT NULL DEFAULT 'two-box',
    "dryRun" BOOLEAN NOT NULL DEFAULT false,
    "promotedFromId" TEXT,
    "applyInput" JSONB NOT NULL,
    "options" JSONB NOT NULL,
    "inputs" JSONB NOT NULL,
    "status" "MigrationRunStatus" NOT NULL DEFAULT 'QUEUED',
    "currentStep" TEXT,
    "ponrAt" TIMESTAMP(3),
    "ponrByUserId" TEXT,
    "pauseRequested" BOOLEAN NOT NULL DEFAULT false,
    "abortRequested" BOOLEAN NOT NULL DEFAULT false,
    "ownerId" TEXT,
    "heartbeatAt" TIMESTAMP(3),
    "activeKey" TEXT,
    "eventSeq" INTEGER NOT NULL DEFAULT 0,
    "windowEstimate" JSONB,
    "freezeStartedAt" TIMESTAMP(3),
    "freezeEndedAt" TIMESTAMP(3),
    "failureStep" TEXT,
    "failureCode" TEXT,
    "report" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MigrationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MigrationRunStep" (
    "runId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "idx" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "status" "MigrationRunStepStatus" NOT NULL DEFAULT 'PENDING',
    "rollbackClass" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "gate" JSONB,
    "approval" JSONB,
    "inputHash" TEXT,
    "progress" JSONB,
    "compensation" JSONB,
    "evidence" JSONB,
    "wait" JSONB,
    "notBefore" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "lastError" TEXT,

    CONSTRAINT "MigrationRunStep_pkey" PRIMARY KEY ("runId","key")
);

-- CreateTable
CREATE TABLE "MigrationRunEvent" (
    "runId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stepKey" TEXT,
    "level" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "params" JSONB,
    "actorId" TEXT,

    CONSTRAINT "MigrationRunEvent_pkey" PRIMARY KEY ("runId","seq")
);

-- CreateIndex
CREATE UNIQUE INDEX "MigrationRun_opId_key" ON "MigrationRun"("opId");

-- CreateIndex
CREATE UNIQUE INDEX "MigrationRun_activeKey_key" ON "MigrationRun"("activeKey");

-- CreateIndex
CREATE INDEX "MigrationRun_teamId_createdAt_idx" ON "MigrationRun"("teamId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "MigrationRun_status_idx" ON "MigrationRun"("status");

-- CreateIndex
CREATE INDEX "MigrationRun_actorId_idx" ON "MigrationRun"("actorId");

-- AddForeignKey
ALTER TABLE "MigrationRunStep" ADD CONSTRAINT "MigrationRunStep_runId_fkey" FOREIGN KEY ("runId") REFERENCES "MigrationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MigrationRunEvent" ADD CONSTRAINT "MigrationRunEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "MigrationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

