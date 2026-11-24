-- AlterTable
ALTER TABLE "Server" ADD COLUMN     "ipv6Source" TEXT NOT NULL DEFAULT 'observed',
ADD COLUMN     "nameAuto" BOOLEAN NOT NULL DEFAULT false;

-- Existing rows keep their single source flag for both families (it guarded both before).
UPDATE "Server" SET "ipv6Source" = "ipSource" WHERE "publicIpv6" IS NOT NULL;
