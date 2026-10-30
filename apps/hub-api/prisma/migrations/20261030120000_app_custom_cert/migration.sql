-- Per-app operator-uploaded custom TLS certificate (certType "custom"): Traefik serves it statically by
-- SNI (no ACME). Additive + all-nullable (certDomains defaults to empty), so existing apps are unchanged.
-- certPem is the public cert chain; certKeyEnc is the AES-encrypted private key (never stored in the clear).

-- AlterTable
ALTER TABLE "Application" ADD COLUMN     "certPem" TEXT,
ADD COLUMN     "certKeyEnc" TEXT,
ADD COLUMN     "certDomains" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "certNotAfter" TIMESTAMP(3);
