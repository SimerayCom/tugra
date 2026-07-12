-- CreateTable
CREATE TABLE "MetricRollup" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "bucket" TIMESTAMP(3) NOT NULL,
    "avgCpu" DOUBLE PRECISION NOT NULL,
    "maxCpu" DOUBLE PRECISION NOT NULL,
    "avgMemUsed" BIGINT NOT NULL,
    "avgMemTotal" BIGINT NOT NULL,
    "avgDiskUsed" BIGINT NOT NULL,
    "avgDiskTotal" BIGINT NOT NULL,
    "avgNetRx" BIGINT NOT NULL,
    "avgNetTx" BIGINT NOT NULL,
    "avgDiskRead" BIGINT NOT NULL,
    "avgDiskWrite" BIGINT NOT NULL,

    CONSTRAINT "MetricRollup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContainerMetricRollup" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "containerName" TEXT NOT NULL,
    "bucket" TIMESTAMP(3) NOT NULL,
    "avgCpu" DOUBLE PRECISION NOT NULL,
    "maxCpu" DOUBLE PRECISION NOT NULL,
    "avgMemUsed" BIGINT NOT NULL,
    "avgMemTotal" BIGINT NOT NULL,
    "avgMemPct" DOUBLE PRECISION NOT NULL,
    "avgNetRx" BIGINT NOT NULL,
    "avgNetTx" BIGINT NOT NULL,
    "avgBlkRead" BIGINT NOT NULL,
    "avgBlkWrite" BIGINT NOT NULL,

    CONSTRAINT "ContainerMetricRollup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MetricRollup_bucket_idx" ON "MetricRollup"("bucket");

-- CreateIndex
CREATE UNIQUE INDEX "MetricRollup_serverId_bucket_key" ON "MetricRollup"("serverId", "bucket");

-- CreateIndex
CREATE INDEX "ContainerMetricRollup_bucket_idx" ON "ContainerMetricRollup"("bucket");

-- CreateIndex
CREATE UNIQUE INDEX "ContainerMetricRollup_serverId_containerName_bucket_key" ON "ContainerMetricRollup"("serverId", "containerName", "bucket");

-- AddForeignKey
ALTER TABLE "MetricRollup" ADD CONSTRAINT "MetricRollup_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContainerMetricRollup" ADD CONSTRAINT "ContainerMetricRollup_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;
