-- AlterTable
ALTER TABLE "Application" ADD COLUMN "healthCmd" TEXT,
ADD COLUMN "memoryMb" INTEGER,
ADD COLUMN "cpus" DOUBLE PRECISION;
