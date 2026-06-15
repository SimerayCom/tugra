-- CreateEnum
CREATE TYPE "DbEngine" AS ENUM ('POSTGRES', 'MYSQL', 'REDIS', 'MONGO');

-- CreateEnum
CREATE TYPE "DbStatus" AS ENUM ('NEW', 'RUNNING', 'STOPPED', 'FAILED');

-- CreateTable
CREATE TABLE "Database" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "engine" "DbEngine" NOT NULL,
    "version" TEXT NOT NULL,
    "image" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "hostPort" INTEGER,
    "credentials" TEXT NOT NULL,
    "status" "DbStatus" NOT NULL DEFAULT 'NEW',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Database_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Database_teamId_idx" ON "Database"("teamId");

-- AddForeignKey
ALTER TABLE "Database" ADD CONSTRAINT "Database_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
