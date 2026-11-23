-- AlterTable
ALTER TABLE "InstanceSettings" ADD COLUMN     "agentEndpointGrace" JSONB,
ADD COLUMN     "ipTlsCertPem" TEXT,
ADD COLUMN     "ipTlsKeyEnc" TEXT,
ADD COLUMN     "ipTlsServedFp" TEXT;

-- AlterTable
ALTER TABLE "Server" ADD COLUMN     "hubEndpointActive" TEXT,
ADD COLUMN     "hubEndpointAt" TIMESTAMP(3),
ADD COLUMN     "hubEndpointError" TEXT,
ADD COLUMN     "hubEndpointPrimary" TEXT,
ADD COLUMN     "hubEndpointRev" BIGINT;
