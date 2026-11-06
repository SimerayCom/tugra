-- Unhealthy-healthcheck alerting (CRASH-3a): track when a container first reported `unhealthy`
-- (continuous, cleared on recovery) and the last time an unhealthy alert fired (its own cooldown,
-- separate from the crash/OOM lastNotifiedAt). Additive, nullable — safe on existing rows.
ALTER TABLE "ContainerState" ADD COLUMN "unhealthySince" TIMESTAMP(3);
ALTER TABLE "ContainerState" ADD COLUMN "healthNotifiedAt" TIMESTAMP(3);
