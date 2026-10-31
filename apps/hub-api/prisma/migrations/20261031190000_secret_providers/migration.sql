-- External secret-store providers (team-scoped credential) + per-app secret references. Additive new
-- tables; existing apps/teams are unaffected. SecretProvider mirrors DnsCredential (encrypted token, never
-- returned). SecretRef.providerId is NO ACTION (not CASCADE): deleting a provider that still has refs is
-- refused at the app layer (409), while a whole-team delete still cascades (NO ACTION is checked at
-- end-of-statement, after the app's SecretRefs die with the app). The fetched secret VALUE is never stored.

-- CreateTable
CREATE TABLE "SecretProvider" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "tokenEnc" TEXT NOT NULL,
    "lastVerifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecretProvider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecretRef" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "envVar" TEXT NOT NULL,
    "remoteKey" TEXT NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecretRef_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SecretProvider_teamId_idx" ON "SecretProvider"("teamId");

-- CreateIndex
CREATE UNIQUE INDEX "SecretRef_appId_envVar_key" ON "SecretRef"("appId", "envVar");

-- CreateIndex
CREATE INDEX "SecretRef_appId_idx" ON "SecretRef"("appId");

-- CreateIndex
CREATE INDEX "SecretRef_providerId_idx" ON "SecretRef"("providerId");

-- AddForeignKey
ALTER TABLE "SecretProvider" ADD CONSTRAINT "SecretProvider_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SecretRef" ADD CONSTRAINT "SecretRef_appId_fkey" FOREIGN KEY ("appId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SecretRef" ADD CONSTRAINT "SecretRef_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "SecretProvider"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
