-- IP allowlist: CIDRs/addresses → a Traefik ipallowlist middleware (empty = open to all).
ALTER TABLE "Application" ADD COLUMN "ipAllowlist" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
