-- Per-app rollback-image retention count (keep-N pruning). Additive + nullable: null keeps the current
-- default of 5 (DEFAULT_DEPLOY_IMAGE_KEEP), so existing apps are unchanged. Clamped to 1..20 at the API.
ALTER TABLE "Application" ADD COLUMN "imagesToKeep" INTEGER;
