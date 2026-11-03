-- Per-app free-text description (Coolify parity). Additive + nullable: existing apps are unchanged. This
-- adds the column + PUT /apps/:id/description so a description CAN be stored and edited on the app page
-- (previously there was nowhere to put one). The Coolify importer does not yet carry the source
-- description into this column — that is a separate follow-up.
ALTER TABLE "Application" ADD COLUMN "description" TEXT;
