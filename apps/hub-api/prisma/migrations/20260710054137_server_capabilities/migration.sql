-- AlterTable
ALTER TABLE "Server" ADD COLUMN     "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[];
