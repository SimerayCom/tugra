-- CreateEnum
CREATE TYPE "AppSource" AS ENUM ('IMAGE', 'GIT');

-- CreateEnum
CREATE TYPE "BuildType" AS ENUM ('NIXPACKS', 'DOCKERFILE');

-- AlterTable
ALTER TABLE "Application" ADD COLUMN     "buildType" "BuildType" NOT NULL DEFAULT 'NIXPACKS',
ADD COLUMN     "dockerfilePath" TEXT,
ADD COLUMN     "gitBranch" TEXT DEFAULT 'main',
ADD COLUMN     "gitUrl" TEXT,
ADD COLUMN     "source" "AppSource" NOT NULL DEFAULT 'IMAGE',
ALTER COLUMN "image" DROP NOT NULL;
