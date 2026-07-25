-- AlterTable
ALTER TABLE "InstanceSettings" ADD COLUMN     "oidcAllowedDomains" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "oidcClientId" TEXT,
ADD COLUMN     "oidcClientSecretEnc" TEXT,
ADD COLUMN     "oidcEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "oidcIssuer" TEXT;
