-- Server operator metadata: a free-text description/note and an IANA timezone applied to the cleanup cron.
-- Additive + nullable, safe on existing rows (NULL timezone = the scheduler's default/UTC as before).
ALTER TABLE "Server" ADD COLUMN "description" TEXT;
ALTER TABLE "Server" ADD COLUMN "timezone" TEXT;
