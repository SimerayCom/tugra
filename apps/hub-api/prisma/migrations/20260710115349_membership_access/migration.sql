-- AlterTable
ALTER TABLE "Membership" ADD COLUMN     "accessedProjects" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "accessedResources" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "restrictedAccess" BOOLEAN NOT NULL DEFAULT false;
