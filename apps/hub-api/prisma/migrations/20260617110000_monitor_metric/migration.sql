-- AlterEnum
ALTER TYPE "MonitorType" ADD VALUE 'METRIC';

-- AlterTable
ALTER TABLE "Monitor" ADD COLUMN "serverId" TEXT,
ADD COLUMN "metric" TEXT,
ADD COLUMN "thresholdPct" INTEGER;
