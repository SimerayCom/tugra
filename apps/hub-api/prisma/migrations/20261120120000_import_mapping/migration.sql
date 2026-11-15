-- Editable import mapping: one persisted profile per source scope + the session's scope label.
ALTER TABLE "ImportSession" ADD COLUMN "scopeKey" TEXT NOT NULL DEFAULT '';

CREATE TABLE "ImportMapping" (
  "id" TEXT NOT NULL,
  "teamId" TEXT NOT NULL,
  "sourceKind" TEXT NOT NULL,
  "baseUrl" TEXT NOT NULL,
  "scopeKey" TEXT NOT NULL DEFAULT '',
  "label" TEXT,
  "mapping" JSONB NOT NULL,
  "mappingHash" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "lastAppliedOpId" TEXT,
  "lastAppliedAt" TIMESTAMP(3),
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ImportMapping_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ImportMapping_teamId_sourceKind_baseUrl_scopeKey_key" ON "ImportMapping"("teamId","sourceKind","baseUrl","scopeKey");
CREATE INDEX "ImportMapping_teamId_idx" ON "ImportMapping"("teamId");
ALTER TABLE "ImportMapping" ADD CONSTRAINT "ImportMapping_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
