-- Last-known container lifecycle state, for crash/OOM transition detection by the container-health poll.
CREATE TABLE "ContainerState" (
    "serverId" TEXT NOT NULL,
    "containerName" TEXT NOT NULL,
    "containerId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "exitCode" INTEGER NOT NULL DEFAULT 0,
    "oomKilled" BOOLEAN NOT NULL DEFAULT false,
    "restartCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "health" TEXT,
    "lastEventTs" BIGINT NOT NULL DEFAULT 0,
    "lastNotifiedKey" TEXT,
    "lastNotifiedAt" TIMESTAMP(3),
    "restartCountAtNotify" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ContainerState_pkey" PRIMARY KEY ("serverId","containerName")
);

CREATE INDEX "ContainerState_updatedAt_idx" ON "ContainerState"("updatedAt");

ALTER TABLE "ContainerState" ADD CONSTRAINT "ContainerState_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;
