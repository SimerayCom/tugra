-- Coolify hub takeover (lane B): time-limited, owner-only consent to read Coolify's values on its host (kind 'secrets') or to install agents with Coolify's SSH keys (kind 'ssh').
-- CreateTable
CREATE TABLE "CoolifyHostGrant" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "classes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "grantedById" TEXT NOT NULL,
    "runId" TEXT,
    "recipientPublicKey" TEXT,
    "recipientKeyEnc" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CoolifyHostGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CoolifyHostGrant_serverId_kind_expiresAt_idx" ON "CoolifyHostGrant"("serverId", "kind", "expiresAt");

-- CreateIndex
CREATE INDEX "CoolifyHostGrant_teamId_createdAt_idx" ON "CoolifyHostGrant"("teamId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "CoolifyHostGrant" ADD CONSTRAINT "CoolifyHostGrant_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoolifyHostGrant" ADD CONSTRAINT "CoolifyHostGrant_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;
