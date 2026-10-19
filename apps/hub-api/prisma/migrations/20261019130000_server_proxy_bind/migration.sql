-- How the server's reverse proxy publishes :80/:443 (CASA-INSTALL-5): "public" (default) | "loopback" | "none"
-- (tunnel-only). Additive, defaulted — existing servers keep today's public binding.
ALTER TABLE "Server" ADD COLUMN "proxyBind" TEXT NOT NULL DEFAULT 'public';
