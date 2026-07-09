-- AlterTable
ALTER TABLE "Application" ADD COLUMN     "healthCheckPath" TEXT,
ADD COLUMN     "healthCheckPort" INTEGER,
ADD COLUMN     "healthCheckType" TEXT;
