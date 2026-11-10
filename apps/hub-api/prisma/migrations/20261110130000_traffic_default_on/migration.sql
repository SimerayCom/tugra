-- AlterTable: Traffic Analytics is on by default for newly enrolled servers (self-hosted: the
-- operator's own visitor data on their own server and hub). Existing servers keep their stored
-- value, so this changes only the default for new rows; operators can still toggle it per server.
ALTER TABLE "Server" ALTER COLUMN "trafficAnalytics" SET DEFAULT true;
