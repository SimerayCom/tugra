-- S3 -> S3 object migration (mc mirror run by the target server's agent). Credentials are stored encrypted.
CREATE TABLE "ObjectMigration" (
  "id" TEXT NOT NULL, "teamId" TEXT NOT NULL, "createdById" TEXT NOT NULL, "name" TEXT NOT NULL,
  "targetServerId" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'DRAFT', "phase" TEXT,
  "srcEndpoint" TEXT NOT NULL, "srcAccessKeyEnc" TEXT NOT NULL, "srcSecretKeyEnc" TEXT NOT NULL,
  "dstEndpoint" TEXT NOT NULL, "dstAccessKeyEnc" TEXT NOT NULL, "dstSecretKeyEnc" TEXT NOT NULL,
  "preserve" BOOLEAN NOT NULL DEFAULT true, "removeExtraneous" BOOLEAN NOT NULL DEFAULT false,
  "mergeIntoExisting" BOOLEAN NOT NULL DEFAULT false, "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
  "warnings" JSONB, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL, "finishedAt" TIMESTAMP(3),
  CONSTRAINT "ObjectMigration_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ObjectMigrationBucket" (
  "id" TEXT NOT NULL, "migrationId" TEXT NOT NULL, "idx" INTEGER NOT NULL,
  "srcBucket" TEXT NOT NULL, "dstBucket" TEXT NOT NULL, "exclude" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "selected" BOOLEAN NOT NULL DEFAULT false, "status" TEXT NOT NULL DEFAULT 'PENDING',
  "srcObjects" BIGINT, "srcBytes" BIGINT, "dstObjects" BIGINT, "dstBytes" BIGINT,
  "doneObjects" BIGINT, "doneBytes" BIGINT, "diffMissing" INTEGER, "diffDiffer" INTEGER, "diffExtra" INTEGER,
  "versioning" TEXT, "config" JSONB, "configStatus" TEXT, "lastError" TEXT,
  "startedAt" TIMESTAMP(3), "finishedAt" TIMESTAMP(3),
  CONSTRAINT "ObjectMigrationBucket_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ObjectMigration_teamId_createdAt_idx" ON "ObjectMigration"("teamId","createdAt");
CREATE INDEX "ObjectMigration_targetServerId_status_idx" ON "ObjectMigration"("targetServerId","status");
CREATE UNIQUE INDEX "ObjectMigrationBucket_migrationId_srcBucket_key" ON "ObjectMigrationBucket"("migrationId","srcBucket");
CREATE UNIQUE INDEX "ObjectMigrationBucket_migrationId_idx_key" ON "ObjectMigrationBucket"("migrationId","idx");

ALTER TABLE "ObjectMigration" ADD CONSTRAINT "ObjectMigration_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ObjectMigrationBucket" ADD CONSTRAINT "ObjectMigrationBucket_migrationId_fkey" FOREIGN KEY ("migrationId") REFERENCES "ObjectMigration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
