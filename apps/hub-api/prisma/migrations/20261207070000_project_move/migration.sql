-- Move a whole project between Tugra servers (lane H): composes the app and database moves, keeps a safety copy.
-- CreateTable
CREATE TABLE "ProjectMove" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "sourceServerId" TEXT NOT NULL,
    "targetServerId" TEXT NOT NULL,
    "phase" TEXT NOT NULL DEFAULT 'QUEUED',
    "plan" JSONB NOT NULL DEFAULT '{}',
    "items" JSONB NOT NULL DEFAULT '[]',
    "retainDays" INTEGER NOT NULL DEFAULT 7,
    "repointDns" BOOLEAN NOT NULL DEFAULT false,
    "archiveUntil" TIMESTAMP(3),
    "failureReason" TEXT,
    "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
    "ownerId" TEXT,
    "heartbeatAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectMove_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProjectMove_projectId_createdAt_idx" ON "ProjectMove"("projectId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "ProjectMove_phase_idx" ON "ProjectMove"("phase");

-- CreateIndex
CREATE INDEX "ProjectMove_teamId_idx" ON "ProjectMove"("teamId");
