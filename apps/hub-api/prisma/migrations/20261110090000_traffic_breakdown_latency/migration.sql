-- AlterTable
ALTER TABLE "TrafficMetric" ADD COLUMN     "botRequests" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "humanRequests" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "TrafficBreakdown" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "bucket" TIMESTAMP(3) NOT NULL,
    "dim" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requests" INTEGER NOT NULL,

    CONSTRAINT "TrafficBreakdown_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrafficLatency" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "bucket" TIMESTAMP(3) NOT NULL,
    "idx" INTEGER NOT NULL,
    "requests" INTEGER NOT NULL,

    CONSTRAINT "TrafficLatency_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TrafficBreakdown_serverId_domain_bucket_dim_idx" ON "TrafficBreakdown"("serverId", "domain", "bucket", "dim");

-- CreateIndex
CREATE INDEX "TrafficBreakdown_bucket_idx" ON "TrafficBreakdown"("bucket");

-- CreateIndex
CREATE UNIQUE INDEX "TrafficBreakdown_serverId_domain_bucket_dim_key_key" ON "TrafficBreakdown"("serverId", "domain", "bucket", "dim", "key");

-- CreateIndex
CREATE INDEX "TrafficLatency_serverId_domain_bucket_idx" ON "TrafficLatency"("serverId", "domain", "bucket");

-- CreateIndex
CREATE INDEX "TrafficLatency_bucket_idx" ON "TrafficLatency"("bucket");

-- CreateIndex
CREATE UNIQUE INDEX "TrafficLatency_serverId_domain_bucket_idx_key" ON "TrafficLatency"("serverId", "domain", "bucket", "idx");

-- AddForeignKey
ALTER TABLE "TrafficBreakdown" ADD CONSTRAINT "TrafficBreakdown_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrafficLatency" ADD CONSTRAINT "TrafficLatency_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

