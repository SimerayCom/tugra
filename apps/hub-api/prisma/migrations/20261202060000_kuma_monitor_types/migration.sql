-- AlterEnum (new check kinds: keyword, ping, dns)
ALTER TYPE "MonitorType" ADD VALUE 'KEYWORD';
ALTER TYPE "MonitorType" ADD VALUE 'PING';
ALTER TYPE "MonitorType" ADD VALUE 'DNS';

-- AlterTable
ALTER TABLE "Monitor"
  ADD COLUMN "method" TEXT,
  ADD COLUMN "keyword" TEXT,
  ADD COLUMN "keywordInvert" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "acceptedStatus" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "httpOptionsEnc" TEXT,
  ADD COLUMN "ignoreTls" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "maxRedirects" INTEGER NOT NULL DEFAULT 10,
  ADD COLUMN "upsideDown" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "dnsRecordType" TEXT,
  ADD COLUMN "dnsServer" TEXT,
  ADD COLUMN "dnsExpect" TEXT;

ALTER TABLE "Heartbeat" ADD COLUMN "cause" TEXT;
