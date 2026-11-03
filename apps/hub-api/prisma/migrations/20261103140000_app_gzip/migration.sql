-- Per-app gzip/compression toggle (Coolify parity). A Traefik `compress` middleware on the routed app.
-- Additive, NOT NULL with a default of false, so existing apps keep today's behaviour (no proxy
-- compression) until the owner opts in.
ALTER TABLE "Application" ADD COLUMN "gzip" BOOLEAN NOT NULL DEFAULT false;
