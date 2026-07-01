-- AlterTable
ALTER TABLE "SavedView" ADD COLUMN     "teamId" TEXT;

-- CreateIndex
CREATE INDEX "SavedView_teamId_idx" ON "SavedView"("teamId");

-- AddForeignKey
ALTER TABLE "SavedView" ADD CONSTRAINT "SavedView_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
