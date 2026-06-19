-- AlterTable
ALTER TABLE "Application" ADD COLUMN "domainRedirect" TEXT,
ADD COLUMN "securityHeaders" BOOLEAN NOT NULL DEFAULT false;
