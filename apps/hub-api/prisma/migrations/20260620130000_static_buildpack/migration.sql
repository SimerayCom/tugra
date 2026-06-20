-- AlterEnum
ALTER TYPE "BuildType" ADD VALUE 'STATIC';

-- AlterTable
ALTER TABLE "Application" ADD COLUMN "buildCommand" TEXT,
ADD COLUMN "outputDir" TEXT;
