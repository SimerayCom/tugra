-- CreateTable
CREATE TABLE "TrafficMetric" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "appId" TEXT,
    "bucket" TIMESTAMP(3) NOT NULL,
    "requests" INTEGER NOT NULL,
    "s2xx" INTEGER NOT NULL,
    "s3xx" INTEGER NOT NULL,
    "s4xx" INTEGER NOT NULL,
    "s5xx" INTEGER NOT NULL,
    "bytes" BIGINT NOT NULL,

    CONSTRAINT "TrafficMetric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrafficPath" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "bucket" TIMESTAMP(3) NOT NULL,
    "path" TEXT NOT NULL,
    "requests" INTEGER NOT NULL,
    "bytes" BIGINT NOT NULL,

    CONSTRAINT "TrafficPath_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TrafficMetric_bucket_idx" ON "TrafficMetric"("bucket");

-- CreateIndex
CREATE INDEX "TrafficMetric_serverId_bucket_idx" ON "TrafficMetric"("serverId", "bucket");

-- CreateIndex
CREATE UNIQUE INDEX "TrafficMetric_serverId_domain_bucket_key" ON "TrafficMetric"("serverId", "domain", "bucket");

-- CreateIndex
CREATE INDEX "TrafficPath_serverId_domain_bucket_idx" ON "TrafficPath"("serverId", "domain", "bucket");

-- CreateIndex
CREATE INDEX "TrafficPath_bucket_idx" ON "TrafficPath"("bucket");

-- CreateIndex
CREATE UNIQUE INDEX "TrafficPath_serverId_domain_bucket_path_key" ON "TrafficPath"("serverId", "domain", "bucket", "path");

-- AddForeignKey
ALTER TABLE "TrafficMetric" ADD CONSTRAINT "TrafficMetric_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrafficPath" ADD CONSTRAINT "TrafficPath_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

