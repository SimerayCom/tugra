-- Per-app custom icon (user-uploaded PNG) stored inline in Postgres so it rides the normal DB backups.
-- Additive: the nullable Application.iconUpdatedAt marker leaves existing apps icon-less (behaviour unchanged).

-- AlterTable
ALTER TABLE "Application" ADD COLUMN     "iconUpdatedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "AppIcon" (
    "appId" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppIcon_pkey" PRIMARY KEY ("appId")
);

-- AddForeignKey
ALTER TABLE "AppIcon" ADD CONSTRAINT "AppIcon_appId_fkey" FOREIGN KEY ("appId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;
