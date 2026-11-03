-- Per-app docker network aliases (Coolify parity). Additive, NOT NULL with an empty-array default, so
-- existing apps are unchanged. Emitted as `--network-alias` flags on the app's user-defined network.
ALTER TABLE "Application" ADD COLUMN "networkAliases" TEXT[] NOT NULL DEFAULT '{}'::text[];
