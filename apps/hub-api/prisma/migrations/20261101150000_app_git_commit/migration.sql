-- Pin deploys to a specific commit SHA (reachable from gitBranch). Null = deploy the branch HEAD.
-- Additive + nullable: existing apps keep NULL → shallow branch-HEAD clone (byte-identical).
ALTER TABLE "Application" ADD COLUMN "gitCommit" TEXT;
