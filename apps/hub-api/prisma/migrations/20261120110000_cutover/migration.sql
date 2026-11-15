-- SSL/DNS cutover for imported apps: per-hostname cutover state, a one-live-run-per-op table, staged source
-- ACME certs (keys encrypted, purged after apply), per-host DNS-01 flag on Application and the DnsCredential a
-- server's DNS-01 resolver token was copied from.
CREATE TABLE "CutoverDomain" (
  "id"              TEXT NOT NULL,
  "opId"            TEXT NOT NULL,
  "applicationId"   TEXT NOT NULL,
  "hostname"        TEXT NOT NULL,
  "role"            TEXT NOT NULL DEFAULT 'primary',
  "state"           TEXT NOT NULL DEFAULT 'PLANNED',
  "blockReason"     TEXT,
  "dnsMode"         TEXT NOT NULL DEFAULT 'manual',
  "dnsCredentialId" TEXT,
  "zoneId"          TEXT,
  "sslMode"         TEXT,
  "challenge"       TEXT NOT NULL DEFAULT 'http01',
  "targetIps"       JSONB,
  "ledger"          JSONB,
  "viaWildcard"     BOOLEAN NOT NULL DEFAULT false,
  "proxied"         BOOLEAN,
  "dnsObserved"     TEXT NOT NULL DEFAULT 'unknown',
  "originalTtl"     INTEGER,
  "targetTtl"       INTEGER,
  "ttlLoweredAt"    TIMESTAMP(3),
  "earliestFlipAt"  TIMESTAMP(3),
  "certState"       TEXT NOT NULL DEFAULT 'unknown',
  "certIssuer"      TEXT,
  "certNotAfter"    TIMESTAMP(3),
  "certError"       TEXT,
  "precheck"        JSONB,
  "precheckAt"      TIMESTAMP(3),
  "needsDeploy"     BOOLEAN NOT NULL DEFAULT false,
  "stateful"        BOOLEAN NOT NULL DEFAULT false,
  "warnings"        TEXT[] DEFAULT ARRAY[]::TEXT[],
  "flippedAt"       TIMESTAMP(3),
  "verifiedAt"      TIMESTAMP(3),
  "finalizedAt"     TIMESTAMP(3),
  "revertedAt"      TIMESTAMP(3),
  "lastError"       TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CutoverDomain_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CutoverDomain_opId_applicationId_hostname_key" ON "CutoverDomain"("opId","applicationId","hostname");
CREATE INDEX "CutoverDomain_opId_idx" ON "CutoverDomain"("opId");
CREATE INDEX "CutoverDomain_applicationId_idx" ON "CutoverDomain"("applicationId");
CREATE INDEX "CutoverDomain_dnsCredentialId_idx" ON "CutoverDomain"("dnsCredentialId");
ALTER TABLE "CutoverDomain" ADD CONSTRAINT "CutoverDomain_opId_fkey" FOREIGN KEY ("opId") REFERENCES "BulkOperation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CutoverDomain" ADD CONSTRAINT "CutoverDomain_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CutoverDomain" ADD CONSTRAINT "CutoverDomain_dnsCredentialId_fkey" FOREIGN KEY ("dnsCredentialId") REFERENCES "DnsCredential"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "CutoverRun" (
  "id"          TEXT NOT NULL,
  "opId"        TEXT NOT NULL,
  "activeKey"   TEXT,
  "status"      TEXT NOT NULL DEFAULT 'running',
  "params"      JSONB NOT NULL,
  "total"       INTEGER NOT NULL,
  "batchesDone" INTEGER NOT NULL DEFAULT 0,
  "heartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastError"   TEXT,
  "startedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt"  TIMESTAMP(3),
  CONSTRAINT "CutoverRun_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CutoverRun_activeKey_key" ON "CutoverRun"("activeKey");
CREATE INDEX "CutoverRun_opId_idx" ON "CutoverRun"("opId");
ALTER TABLE "CutoverRun" ADD CONSTRAINT "CutoverRun_opId_fkey" FOREIGN KEY ("opId") REFERENCES "BulkOperation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "CutoverCert" (
  "id"              TEXT NOT NULL,
  "opId"            TEXT NOT NULL,
  "hosts"           TEXT[],
  "certPem"         TEXT NOT NULL,
  "keyEnc"          TEXT NOT NULL,
  "fingerprint"     TEXT NOT NULL,
  "notBefore"       TIMESTAMP(3) NOT NULL,
  "notAfter"        TIMESTAMP(3) NOT NULL,
  "appliedAt"       TIMESTAMP(3),
  "appliedServerId" TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CutoverCert_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CutoverCert_opId_fingerprint_key" ON "CutoverCert"("opId","fingerprint");
CREATE INDEX "CutoverCert_opId_idx" ON "CutoverCert"("opId");
ALTER TABLE "CutoverCert" ADD CONSTRAINT "CutoverCert_opId_fkey" FOREIGN KEY ("opId") REFERENCES "BulkOperation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Application" ADD COLUMN "dnsChallenge" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Server" ADD COLUMN "dnsCredentialId" TEXT;
ALTER TABLE "Server" ADD CONSTRAINT "Server_dnsCredentialId_fkey" FOREIGN KEY ("dnsCredentialId") REFERENCES "DnsCredential"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Server_dnsCredentialId_idx" ON "Server"("dnsCredentialId");
