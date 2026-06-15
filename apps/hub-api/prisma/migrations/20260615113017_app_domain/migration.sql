-- AlterTable
ALTER TABLE "Application" ADD COLUMN     "domain" TEXT,
ADD COLUMN     "https" BOOLEAN NOT NULL DEFAULT true;
