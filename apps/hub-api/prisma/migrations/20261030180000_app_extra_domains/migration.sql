-- Multi-domain routing: additional hostnames (aliases) that route to the same container as `domain`.
ALTER TABLE "Application" ADD COLUMN "extraDomains" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
