-- CreateTable
CREATE TABLE "TrafficCountry" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "bucket" TIMESTAMP(3) NOT NULL,
    "country" TEXT NOT NULL,
    "requests" INTEGER NOT NULL,

    CONSTRAINT "TrafficCountry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TrafficCountry_serverId_domain_bucket_idx" ON "TrafficCountry"("serverId", "domain", "bucket");

-- CreateIndex
CREATE INDEX "TrafficCountry_bucket_idx" ON "TrafficCountry"("bucket");

-- CreateIndex
CREATE UNIQUE INDEX "TrafficCountry_serverId_domain_bucket_country_key" ON "TrafficCountry"("serverId", "domain", "bucket", "country");

-- AddForeignKey
ALTER TABLE "TrafficCountry" ADD CONSTRAINT "TrafficCountry_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;
