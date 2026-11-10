-- CreateTable
CREATE TABLE "TrafficUnique" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "bucket" TIMESTAMP(3) NOT NULL,
    "sketch" BYTEA NOT NULL,

    CONSTRAINT "TrafficUnique_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TrafficUnique_serverId_domain_bucket_idx" ON "TrafficUnique"("serverId", "domain", "bucket");

-- CreateIndex
CREATE INDEX "TrafficUnique_bucket_idx" ON "TrafficUnique"("bucket");

-- CreateIndex
CREATE UNIQUE INDEX "TrafficUnique_serverId_domain_bucket_key" ON "TrafficUnique"("serverId", "domain", "bucket");

-- AddForeignKey
ALTER TABLE "TrafficUnique" ADD CONSTRAINT "TrafficUnique_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "TrafficUniqueHour" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "bucket" TIMESTAMP(3) NOT NULL,
    "sketch" BYTEA NOT NULL,

    CONSTRAINT "TrafficUniqueHour_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TrafficUniqueHour_serverId_domain_bucket_idx" ON "TrafficUniqueHour"("serverId", "domain", "bucket");

-- CreateIndex
CREATE INDEX "TrafficUniqueHour_bucket_idx" ON "TrafficUniqueHour"("bucket");

-- CreateIndex
CREATE UNIQUE INDEX "TrafficUniqueHour_serverId_domain_bucket_key" ON "TrafficUniqueHour"("serverId", "domain", "bucket");

-- AddForeignKey
ALTER TABLE "TrafficUniqueHour" ADD CONSTRAINT "TrafficUniqueHour_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;
