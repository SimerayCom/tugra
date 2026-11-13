-- CreateTable
CREATE TABLE "BaseBackup" (
    "id" TEXT NOT NULL,
    "databaseId" TEXT NOT NULL,
    "status" "BackupStatus" NOT NULL DEFAULT 'PENDING',
    "filename" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "destinationId" TEXT,
    "objectKey" TEXT,
    "sizeBytes" BIGINT,
    "pgVersion" TEXT,
    "startLsn" TEXT,
    "timeline" INTEGER,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "exitCode" INTEGER,
    "errorTail" TEXT,
    "durationMs" INTEGER,

    CONSTRAINT "BaseBackup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BaseBackup_databaseId_createdAt_idx" ON "BaseBackup"("databaseId", "createdAt");

-- CreateIndex (partial unique: at most ONE in-flight base backup per database — the atomic backstop for the
-- runner's check-then-create inflight guard, so two concurrent requests cannot both start a heavy base. Not
-- modeled in schema.prisma because Prisma has no partial-index support; the runner catches the P2002.)
CREATE UNIQUE INDEX "BaseBackup_one_running_per_db_idx" ON "BaseBackup"("databaseId") WHERE "status" = 'RUNNING';

-- AddForeignKey
ALTER TABLE "BaseBackup" ADD CONSTRAINT "BaseBackup_databaseId_fkey" FOREIGN KEY ("databaseId") REFERENCES "Database"("id") ON DELETE CASCADE ON UPDATE CASCADE;
