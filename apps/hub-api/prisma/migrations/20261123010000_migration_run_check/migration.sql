-- P7 lane B: queryable verification evidence of a migration run (loose runId, no FK).
-- CreateTable
CREATE TABLE "MigrationRunCheck" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "stepKey" TEXT NOT NULL,
    "checkId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "evidenceKind" TEXT NOT NULL,
    "evidence" JSONB,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MigrationRunCheck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MigrationRunCheck_runId_stepKey_idx" ON "MigrationRunCheck"("runId", "stepKey");

-- CreateIndex
CREATE UNIQUE INDEX "MigrationRunCheck_runId_stepKey_checkId_subject_key" ON "MigrationRunCheck"("runId", "stepKey", "checkId", "subject");
