-- Docker restart policy for the app container (no | always | unless-stopped | on-failure).
-- Additive + nullable: existing apps keep NULL → the "unless-stopped" default (byte-identical run line).
ALTER TABLE "Application" ADD COLUMN "restartPolicy" TEXT;
