-- Per-app deploy/rollback timeout override (null = default 300s).
ALTER TABLE "Application" ADD COLUMN "deployTimeoutSec" INTEGER;
