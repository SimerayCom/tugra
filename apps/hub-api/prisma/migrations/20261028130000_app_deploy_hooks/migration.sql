-- Per-app pre/post-deploy hook commands.
-- Additive + nullable: existing rows get NULL (no hooks) — deploy behaviour unchanged.

-- AlterTable
ALTER TABLE "Application" ADD COLUMN     "preDeployCommand" TEXT,
ADD COLUMN     "postDeployCommand" TEXT;
