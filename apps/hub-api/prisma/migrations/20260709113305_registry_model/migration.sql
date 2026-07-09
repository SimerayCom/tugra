-- AlterTable
ALTER TABLE "Application" ADD COLUMN     "pushToRegistry" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "registryId" TEXT;

-- CreateTable
CREATE TABLE "Registry" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'generic',
    "url" TEXT,
    "username" TEXT NOT NULL,
    "passwordEnc" TEXT NOT NULL,
    "imagePrefix" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Registry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Registry_teamId_idx" ON "Registry"("teamId");

-- AddForeignKey
ALTER TABLE "Registry" ADD CONSTRAINT "Registry_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_registryId_fkey" FOREIGN KEY ("registryId") REFERENCES "Registry"("id") ON DELETE SET NULL ON UPDATE CASCADE;
