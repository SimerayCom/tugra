-- Per-app custom container labels. NULL = none; existing rows unchanged.
ALTER TABLE "Application" ADD COLUMN "customLabels" JSONB;
