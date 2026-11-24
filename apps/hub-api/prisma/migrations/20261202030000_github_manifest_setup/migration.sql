-- GitHub App manifest flow: user-bound single-use setup tickets, and the per-account installations of a GitHub App source.
-- CreateTable
CREATE TABLE "GitSourceInstallation" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "installationId" TEXT NOT NULL,
    "accountLogin" TEXT,
    "accountType" TEXT,
    "avatarUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GitSourceInstallation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GitSourceSetup" (
    "id" TEXT NOT NULL,
    "stateHash" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "name" TEXT,
    "sharedAllTeams" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GitSourceSetup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GitSourceInstallation_sourceId_installationId_key" ON "GitSourceInstallation"("sourceId", "installationId");

-- CreateIndex
CREATE UNIQUE INDEX "GitSourceSetup_stateHash_key" ON "GitSourceSetup"("stateHash");

-- CreateIndex
CREATE INDEX "GitSourceSetup_expiresAt_idx" ON "GitSourceSetup"("expiresAt");

-- AddForeignKey
ALTER TABLE "GitSourceInstallation" ADD CONSTRAINT "GitSourceInstallation_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "GitSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

