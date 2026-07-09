-- AlterTable
ALTER TABLE "Server" ADD COLUMN     "certMode" TEXT NOT NULL DEFAULT 'http',
ADD COLUMN     "customCertResolver" TEXT,
ADD COLUMN     "dnsCredsEnc" TEXT,
ADD COLUMN     "dnsProvider" TEXT;
