-- AlterTable
ALTER TABLE "Application" ADD COLUMN     "clusterId" TEXT,
ADD COLUMN     "replicas" INTEGER;

-- CreateIndex
CREATE INDEX "Application_clusterId_idx" ON "Application"("clusterId");

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "Cluster"("id") ON DELETE SET NULL ON UPDATE CASCADE;
