-- Anonymous usage stats (on by default, opt-out). Three additive columns on the InstanceSettings
-- singleton: `telemetryEnabled` is the owner-UI off-switch (default true = on, opt-out); the env var
-- TUGRA_TELEMETRY=0 is a separate deployment-level hard-off that overrides it. `telemetryInstanceId` is a
-- random anonymous id minted once and kept stable (the ONLY identifier sent — no IP/host/domain/PII ever
-- leaves the box). `telemetryLastSentAt` records the last successful send. Existing rows default to
-- enabled with a null id (minted lazily on first send) and a null last-sent.

-- AlterTable
ALTER TABLE "InstanceSettings" ADD COLUMN     "telemetryEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "telemetryInstanceId" TEXT,
ADD COLUMN     "telemetryLastSentAt" TIMESTAMP(3);
