-- Memory-pressure (pre-OOM) alerting (CRASH-3b): track the last time a sustained-high-memory alert
-- fired for a container, as its own cooldown (separate from crash/OOM and unhealthy). Additive, nullable.
ALTER TABLE "ContainerState" ADD COLUMN "memNotifiedAt" TIMESTAMP(3);
