-- CreateEnum
CREATE TYPE "DestType" AS ENUM ('LOCAL', 'S3');

-- AlterTable
ALTER TABLE "Database" ADD COLUMN     "backupDestinationId" TEXT;

-- AlterTable
ALTER TABLE "Backup" ADD COLUMN     "destinationId" TEXT,
ADD COLUMN     "objectKey" TEXT;

-- CreateTable
CREATE TABLE "BackupDestination" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "DestType" NOT NULL DEFAULT 'S3',
    "s3Bucket" TEXT,
    "s3Region" TEXT,
    "s3Endpoint" TEXT,
    "s3AccessKey" TEXT,
    "s3SecretKey" TEXT,
    "s3Prefix" TEXT,
    "encryptionEnabled" BOOLEAN NOT NULL DEFAULT false,
    "encryptionKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BackupDestination_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BackupDestination_teamId_idx" ON "BackupDestination"("teamId");

-- AddForeignKey
ALTER TABLE "BackupDestination" ADD CONSTRAINT "BackupDestination_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
