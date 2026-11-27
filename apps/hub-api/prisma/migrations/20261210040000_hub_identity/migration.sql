-- Anonymous usage stats: an ed25519 hub identity replaces the random instance id.
ALTER TABLE "InstanceSettings" DROP COLUMN "telemetryInstanceId";
ALTER TABLE "InstanceSettings" ADD COLUMN "hubPublicKey" TEXT;
ALTER TABLE "InstanceSettings" ADD COLUMN "hubPrivateKeyEnc" TEXT;
