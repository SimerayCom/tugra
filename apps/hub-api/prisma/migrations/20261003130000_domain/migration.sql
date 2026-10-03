-- CreateTable
CREATE TABLE "Domain" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "apex" BOOLEAN NOT NULL DEFAULT false,
    "provider" TEXT NOT NULL,
    "dnsCredentialId" TEXT,
    "zoneId" TEXT,
    "recordIds" JSONB,
    "mode" TEXT NOT NULL DEFAULT 'auto',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "lastError" TEXT,
    "lastCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Domain_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Domain_applicationId_hostname_key" ON "Domain"("applicationId", "hostname");

-- CreateIndex
CREATE INDEX "Domain_applicationId_idx" ON "Domain"("applicationId");

-- CreateIndex
CREATE INDEX "Domain_dnsCredentialId_idx" ON "Domain"("dnsCredentialId");

-- AddForeignKey
ALTER TABLE "Domain" ADD CONSTRAINT "Domain_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Domain" ADD CONSTRAINT "Domain_dnsCredentialId_fkey" FOREIGN KEY ("dnsCredentialId") REFERENCES "DnsCredential"("id") ON DELETE SET NULL ON UPDATE CASCADE;
