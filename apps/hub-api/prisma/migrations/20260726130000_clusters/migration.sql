-- CreateTable
CREATE TABLE "Cluster" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Cluster_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Server" ADD COLUMN     "clusterId" TEXT;

-- CreateIndex
CREATE INDEX "Cluster_teamId_idx" ON "Cluster"("teamId");

-- CreateIndex
CREATE UNIQUE INDEX "Cluster_teamId_name_key" ON "Cluster"("teamId", "name");

-- CreateIndex
CREATE INDEX "Server_clusterId_idx" ON "Server"("clusterId");

-- AddForeignKey
ALTER TABLE "Cluster" ADD CONSTRAINT "Cluster_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Server" ADD CONSTRAINT "Server_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "Cluster"("id") ON DELETE SET NULL ON UPDATE CASCADE;
