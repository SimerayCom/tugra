-- Anonymous usage stats: an ed25519 hub identity replaces the random instance id.
-- The old "telemetryInstanceId" column stays (unused) so an older image still reads this table after a rollback.
ALTER TABLE "InstanceSettings" ADD COLUMN "hubPublicKey" TEXT;
ALTER TABLE "InstanceSettings" ADD COLUMN "hubPrivateKeyEnc" TEXT;
