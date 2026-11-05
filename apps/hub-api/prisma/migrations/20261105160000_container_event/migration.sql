-- Append-only crash/OOM episode history per container, written by the container-health poll.
-- Powers the crash timeline + frozen pre-crash log tail. Pruned by RetentionRunnerService.
CREATE TABLE "ContainerEvent" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "containerName" TEXT NOT NULL,
    "containerId" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "kind" TEXT NOT NULL,
    "exitCode" INTEGER NOT NULL DEFAULT 0,
    "oomKilled" BOOLEAN NOT NULL DEFAULT false,
    "restartCount" INTEGER NOT NULL DEFAULT 0,
    "restartDelta" INTEGER NOT NULL DEFAULT 0,
    "reason" TEXT,
    "logTail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ContainerEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ContainerEvent_serverId_containerName_ts_idx" ON "ContainerEvent"("serverId","containerName","ts");

CREATE INDEX "ContainerEvent_createdAt_idx" ON "ContainerEvent"("createdAt");

ALTER TABLE "ContainerEvent" ADD CONSTRAINT "ContainerEvent_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;
