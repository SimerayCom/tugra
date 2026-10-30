-- Optional disk-usage threshold (%) for the per-server scheduled Docker cleanup: the scheduled run only
-- prunes when the server's latest reported disk usage is at or above this percentage (a manual "Clean now"
-- always runs, ignoring it). Additive + nullable, so existing servers keep their time-based schedule.

-- AlterTable
ALTER TABLE "Server" ADD COLUMN     "cleanupThresholdPct" INTEGER;
