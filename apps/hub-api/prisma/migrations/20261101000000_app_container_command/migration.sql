-- Per-app container ENTRYPOINT/CMD override (exec-form argv) for IMAGE and GIT classic (docker run) apps.
-- Additive and nullable; no backfill. containerEntrypoint [] clears the image entrypoint; null = image default.
ALTER TABLE "Application"
  ADD COLUMN "containerEntrypoint" JSONB,
  ADD COLUMN "containerCommand" JSONB;
