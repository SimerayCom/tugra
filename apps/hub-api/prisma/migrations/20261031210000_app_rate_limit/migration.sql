-- Per-app rate limit for applications: {average, burst, period} rendered into a Traefik ratelimit
-- middleware. Additive + nullable, safe on existing rows (NULL = no rate limit, byte-identical routing).
ALTER TABLE "Application" ADD COLUMN "rateLimit" JSONB;
