-- 5-minute rollup tier. Two NEW empty tables: no rewrite or lock on the live metric tables. They are filled at
-- runtime by the rollup job in batches (it back-fills from the existing 1-minute rollups, 24 h of history per run).
CREATE TABLE "MetricRollup5m" (
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
    "avgLoad1" DOUBLE PRECISION,
    "avgLoad5" DOUBLE PRECISION,
    "avgLoad15" DOUBLE PRECISION,
    "avgSwapUsed" BIGINT,
    "avgSwapTotal" BIGINT,

    CONSTRAINT "MetricRollup5m_pkey" PRIMARY KEY ("serverId","bucket")
);

CREATE TABLE "ContainerMetricRollup5m" (
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

    CONSTRAINT "ContainerMetricRollup5m_pkey" PRIMARY KEY ("serverId","containerName","bucket")
);

CREATE INDEX "MetricRollup5m_bucket_idx" ON "MetricRollup5m"("bucket");
CREATE INDEX "ContainerMetricRollup5m_bucket_idx" ON "ContainerMetricRollup5m"("bucket");

ALTER TABLE "MetricRollup5m" ADD CONSTRAINT "MetricRollup5m_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContainerMetricRollup5m" ADD CONSTRAINT "ContainerMetricRollup5m_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;
