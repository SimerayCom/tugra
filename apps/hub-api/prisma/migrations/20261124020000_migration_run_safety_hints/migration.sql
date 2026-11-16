-- P7 grup-7 safety lane: operator/host-attested hints a run consults (image digests of unpinned source images, job-runner marks of apps).
-- CreateTable
CREATE TABLE "MigrationRunHint" (
    "runId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT '',
    "value" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MigrationRunHint_pkey" PRIMARY KEY ("runId","kind","key","scope")
);

-- AddForeignKey
ALTER TABLE "MigrationRunHint" ADD CONSTRAINT "MigrationRunHint_runId_fkey" FOREIGN KEY ("runId") REFERENCES "MigrationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
