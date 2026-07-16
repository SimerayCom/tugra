-- AlterTable
ALTER TABLE "User" ADD COLUMN     "isInstanceOwner" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "ApiToken" ADD COLUMN     "scopes" TEXT[] DEFAULT ARRAY['read']::TEXT[];

-- Backfill: existing tokens were unscoped (all-powerful). Grant them the full scope set so a later
-- enforcement slice does not silently downgrade legacy tokens to read-only (mirrors the
-- server_capabilities backfill: preserve existing behaviour, new tokens default to least-privilege 'read').
UPDATE "ApiToken" SET "scopes" = ARRAY['read','write','deploy','admin','read:secrets']::TEXT[];

-- CreateTable
CREATE TABLE "InstanceSettings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "initializedAt" TIMESTAMP(3),
    "allowRegistration" BOOLEAN NOT NULL DEFAULT false,
    "edition" TEXT NOT NULL DEFAULT 'community',
    "publicUrl" TEXT,
    "acmeEmail" TEXT,
    "autoUpdate" BOOLEAN NOT NULL DEFAULT false,
    "updateChannel" TEXT NOT NULL DEFAULT 'stable',
    "cachedLatestVersion" TEXT,
    "apiEnabled" BOOLEAN NOT NULL DEFAULT true,
    "apiAllowedIps" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InstanceSettings_pkey" PRIMARY KEY ("id")
);
