-- Server scan: the last read-only inventory of what runs on a server (containers, PM2, web sites, services, ports).
ALTER TABLE "Server" ADD COLUMN "scanReport" JSONB;
ALTER TABLE "Server" ADD COLUMN "scannedAt" TIMESTAMP(3);
