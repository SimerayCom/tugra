-- Deployment config diff (Coolify/Dokploy parity): store a redacted config
-- snapshot per deploy so the Deployments view can show what changed.
ALTER TABLE "Deployment" ADD COLUMN "configSnapshot" JSONB;
