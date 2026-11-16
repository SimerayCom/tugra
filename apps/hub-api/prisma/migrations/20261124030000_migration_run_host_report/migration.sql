-- P7 grup-7 source runner lane: per-host reports of the coolify-host-loop runner and of the host inventory (docker ps vs API cross-check).
-- CreateTable
CREATE TABLE "MigrationRunHostReport" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "stepKey" TEXT NOT NULL,
    "sourceServerRef" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "payload" JSONB,
    "reportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MigrationRunHostReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MigrationRunHostReport_runId_kind_idx" ON "MigrationRunHostReport"("runId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "MigrationRunHostReport_runId_stepKey_sourceServerRef_kind_key" ON "MigrationRunHostReport"("runId", "stepKey", "sourceServerRef", "kind");
