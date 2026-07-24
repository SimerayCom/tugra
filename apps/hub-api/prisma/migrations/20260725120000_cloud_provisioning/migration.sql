-- CreateTable
CREATE TABLE "CloudCredential" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "apiTokenEnc" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CloudCredential_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CloudCredential_teamId_idx" ON "CloudCredential"("teamId");

-- AddForeignKey
ALTER TABLE "CloudCredential" ADD CONSTRAINT "CloudCredential_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "Server" ADD COLUMN     "provider" TEXT,
ADD COLUMN     "providerServerId" TEXT,
ADD COLUMN     "cloudCredentialId" TEXT;

-- AddForeignKey
ALTER TABLE "Server" ADD CONSTRAINT "Server_cloudCredentialId_fkey" FOREIGN KEY ("cloudCredentialId") REFERENCES "CloudCredential"("id") ON DELETE SET NULL ON UPDATE CASCADE;
