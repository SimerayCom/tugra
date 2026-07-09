-- AlterTable
ALTER TABLE "Application" ADD COLUMN     "certType" TEXT NOT NULL DEFAULT 'http',
ADD COLUMN     "domainKind" TEXT NOT NULL DEFAULT 'none',
ADD COLUMN     "exposeMode" TEXT NOT NULL DEFAULT 'magic';

-- Backfill: existing apps that already have a domain are user-set ("custom") and
-- are served over HTTPS today. Pin them to certType 'le-http' so the certType-aware
-- Traefik labels (next slice) keep them on HTTPS instead of dropping them to plain HTTP.
UPDATE "Application" SET "domainKind" = 'custom', "exposeMode" = 'custom', "certType" = 'le-http' WHERE "domain" IS NOT NULL;

-- AlterTable
ALTER TABLE "Server" ADD COLUMN     "magicSuffix" TEXT,
ADD COLUMN     "wildcardDomain" TEXT;
