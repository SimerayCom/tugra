-- Custom redirect rules [{regex, replacement, permanent}] → one Traefik redirectregex middleware each.
-- Additive + nullable: existing apps keep NULL (no redirects, byte-identical labels).
ALTER TABLE "Application" ADD COLUMN "redirects" JSONB;
