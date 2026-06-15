-- AlterTable
ALTER TABLE "Server" ADD COLUMN     "agentPublicKey" TEXT,
ADD COLUMN     "agentVersion" TEXT,
ADD COLUMN     "enrollTokenExpiresAt" TIMESTAMP(3),
ADD COLUMN     "hostname" TEXT,
ALTER COLUMN "seal" DROP NOT NULL;
