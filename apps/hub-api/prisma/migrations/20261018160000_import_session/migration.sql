-- Encrypted, short-lived connection to an external source PaaS (Coolify) for the importer.
CREATE TABLE "ImportSession" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "tokenEnc" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "ImportSession_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ImportSession_teamId_idx" ON "ImportSession"("teamId");
