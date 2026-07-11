-- CreateTable
CREATE TABLE "ContainerMetric" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "containerName" TEXT NOT NULL,
    "containerId" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cpu" DOUBLE PRECISION NOT NULL,
    "memUsed" BIGINT NOT NULL,
    "memTotal" BIGINT NOT NULL,
    "memPct" DOUBLE PRECISION NOT NULL,
    "netRx" BIGINT NOT NULL,
    "netTx" BIGINT NOT NULL,
    "blkRead" BIGINT NOT NULL,
    "blkWrite" BIGINT NOT NULL,

    CONSTRAINT "ContainerMetric_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContainerMetric_serverId_containerName_ts_idx" ON "ContainerMetric"("serverId", "containerName", "ts");

-- CreateIndex
CREATE INDEX "ContainerMetric_ts_idx" ON "ContainerMetric"("ts");

-- AddForeignKey
ALTER TABLE "ContainerMetric" ADD CONSTRAINT "ContainerMetric_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;
