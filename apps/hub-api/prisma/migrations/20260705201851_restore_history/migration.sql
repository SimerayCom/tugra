-- CreateEnum
CREATE TYPE "RestoreKind" AS ENUM ('RESTORE', 'RESTORE_TO', 'IMPORT_URL');

-- CreateEnum
CREATE TYPE "RestoreStatus" AS ENUM ('RUNNING', 'SUCCESS', 'FAILED');

-- CreateTable
CREATE TABLE "Restore" (
    "id" TEXT NOT NULL,
    "databaseId" TEXT NOT NULL,
    "backupId" TEXT,
    "sourceDatabaseId" TEXT,
    "kind" "RestoreKind" NOT NULL,
    "status" "RestoreStatus" NOT NULL DEFAULT 'RUNNING',
    "exitCode" INTEGER,
    "errorTail" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Restore_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Restore_databaseId_createdAt_idx" ON "Restore"("databaseId", "createdAt");

-- AddForeignKey
ALTER TABLE "Restore" ADD CONSTRAINT "Restore_databaseId_fkey" FOREIGN KEY ("databaseId") REFERENCES "Database"("id") ON DELETE CASCADE ON UPDATE CASCADE;
