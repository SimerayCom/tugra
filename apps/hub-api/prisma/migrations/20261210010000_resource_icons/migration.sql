-- AlterTable
ALTER TABLE "Application" ADD COLUMN "iconKey" TEXT;

-- AlterTable
ALTER TABLE "Database" ADD COLUMN "iconKey" TEXT;

-- CreateTable
CREATE TABLE "AppFavicon" (
    "appId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "mime" TEXT,
    "data" BYTEA,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppFavicon_pkey" PRIMARY KEY ("appId")
);

-- AddForeignKey
ALTER TABLE "AppFavicon" ADD CONSTRAINT "AppFavicon_appId_fkey" FOREIGN KEY ("appId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;
