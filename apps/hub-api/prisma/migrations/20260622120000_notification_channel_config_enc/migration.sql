-- Notification channels: encrypt config (secrets never plaintext) + per-channel
-- global event subscriptions (deploy_success/deploy_failed/server_offline…).
-- Pre-release: existing channels (if any) are dropped; users re-create them.
ALTER TABLE "NotificationChannel" DROP COLUMN "config";
ALTER TABLE "NotificationChannel" ADD COLUMN "configEnc" TEXT NOT NULL DEFAULT '';
ALTER TABLE "NotificationChannel" ALTER COLUMN "configEnc" DROP DEFAULT;
ALTER TABLE "NotificationChannel" ADD COLUMN "eventTypes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
