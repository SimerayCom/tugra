-- AlterTable
ALTER TABLE "Server" ADD COLUMN     "os" TEXT,
ADD COLUMN     "osVersion" TEXT,
ADD COLUMN     "arch" TEXT,
ADD COLUMN     "kernel" TEXT,
ADD COLUMN     "cpuCores" INTEGER,
ADD COLUMN     "memTotalBytes" BIGINT,
ADD COLUMN     "bootTime" TIMESTAMP(3);
