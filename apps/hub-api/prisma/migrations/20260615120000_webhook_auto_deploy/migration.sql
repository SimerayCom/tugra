-- AlterTable
ALTER TABLE "Application" ADD COLUMN     "webhookSecret" TEXT,
ADD COLUMN     "webhookToken" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Application_webhookToken_key" ON "Application"("webhookToken");
