-- AlterTable
ALTER TABLE "Server" ADD COLUMN "cleanupEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "cleanupIntervalHours" INTEGER,
ADD COLUMN "cleanupVolumes" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "lastCleanupAt" TIMESTAMP(3);
