-- Deploy-history enrichment: wall-clock duration, trigger origin, and deployed git commit.
-- Additive + nullable: existing rows get NULL (unknown duration/trigger/commit) — behaviour unchanged.

-- AlterTable
ALTER TABLE "Deployment" ADD COLUMN     "durationMs" INTEGER,
ADD COLUMN     "trigger" TEXT,
ADD COLUMN     "commitSha" TEXT,
ADD COLUMN     "commitMessage" TEXT;
