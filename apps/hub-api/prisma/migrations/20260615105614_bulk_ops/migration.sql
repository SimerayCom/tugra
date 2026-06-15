-- CreateEnum
CREATE TYPE "BulkTaskStatus" AS ENUM ('PENDING', 'RUNNING', 'DONE', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "BulkOperation" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BulkOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BulkTask" (
    "id" TEXT NOT NULL,
    "opId" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "status" "BulkTaskStatus" NOT NULL DEFAULT 'PENDING',
    "exitCode" INTEGER,
    "output" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "BulkTask_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BulkTask_opId_idx" ON "BulkTask"("opId");

-- AddForeignKey
ALTER TABLE "BulkTask" ADD CONSTRAINT "BulkTask_opId_fkey" FOREIGN KEY ("opId") REFERENCES "BulkOperation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
