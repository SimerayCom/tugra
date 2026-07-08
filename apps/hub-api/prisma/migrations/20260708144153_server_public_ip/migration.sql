-- AlterTable
ALTER TABLE "Server" ADD COLUMN     "ipSource" TEXT NOT NULL DEFAULT 'observed',
ADD COLUMN     "publicIp" TEXT,
ADD COLUMN     "publicIpv6" TEXT,
ADD COLUMN     "reportedIps" TEXT[] DEFAULT ARRAY[]::TEXT[];
