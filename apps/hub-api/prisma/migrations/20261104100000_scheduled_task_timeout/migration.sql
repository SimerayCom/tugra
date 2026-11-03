-- Per-task run timeout (Coolify parity: a scheduled task was hard-capped at 300s, cutting long backups/
-- reports). Additive + nullable: null keeps the built-in 300s default, so existing tasks are unchanged.
ALTER TABLE "ScheduledTask" ADD COLUMN "timeoutSec" INTEGER;
