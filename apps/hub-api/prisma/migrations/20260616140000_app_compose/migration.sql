-- AlterEnum
ALTER TYPE "AppSource" ADD VALUE 'COMPOSE';

-- AlterTable
ALTER TABLE "Application" ADD COLUMN     "composeFile" TEXT;
