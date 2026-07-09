-- AlterTable
ALTER TABLE "Application" ADD COLUMN     "deployStrategy" TEXT NOT NULL DEFAULT 'ROLLING',
ADD COLUMN     "rollbackOnFailure" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "Deployment" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'DEPLOY';
