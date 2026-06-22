-- Git sources: registered GitHub Apps for private-repo deploys.
CREATE TABLE "GitSource" (
  "id" TEXT NOT NULL,
  "teamId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'github',
  "appId" TEXT NOT NULL,
  "appSlug" TEXT,
  "clientId" TEXT,
  "clientSecretEnc" TEXT,
  "privateKeyEnc" TEXT NOT NULL,
  "webhookSecretEnc" TEXT,
  "installationId" TEXT,
  "htmlUrl" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GitSource_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "GitSource_teamId_idx" ON "GitSource"("teamId");

ALTER TABLE "GitSource"
  ADD CONSTRAINT "GitSource_teamId_fkey"
  FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Application" ADD COLUMN "gitSourceId" TEXT;

ALTER TABLE "Application"
  ADD CONSTRAINT "Application_gitSourceId_fkey"
  FOREIGN KEY ("gitSourceId") REFERENCES "GitSource"("id") ON DELETE SET NULL ON UPDATE CASCADE;
