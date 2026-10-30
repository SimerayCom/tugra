-- Deploy queue: a second deploy for a busy app is now QUEUED (not 409), and a queued deploy can be CANCELLED.
-- PG16 allows ALTER TYPE ... ADD VALUE inside a transaction as long as the new value is not USED in the same
-- transaction — so this migration only references the pre-existing RUNNING/FAILED values below.
ALTER TYPE "DeploymentStatus" ADD VALUE 'QUEUED';
ALTER TYPE "DeploymentStatus" ADD VALUE 'CANCELLED';

-- Queue bookkeeping columns.
ALTER TABLE "Deployment"
  ADD COLUMN "noCache" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "requestedBy" TEXT,
  ADD COLUMN "startedAt" TIMESTAMP(3);

-- Any pre-existing duplicate RUNNING rows (possible today: a webhook/preview/first deploy could start a second
-- run while one was already RUNNING) would break the partial unique index below. Fail them first — a migration
-- always precedes a hub restart, and boot reconcile fails every RUNNING row anyway. Uses only existing values.
UPDATE "Deployment" SET "status" = 'FAILED', "exitCode" = -1 WHERE "status" = 'RUNNING';

-- One RUNNING deploy per app, enforced at the DB level (backstop for the SELECT ... FOR UPDATE claim).
CREATE UNIQUE INDEX "deployment_one_running_per_app" ON "Deployment" ("appId") WHERE "status" = 'RUNNING';

-- Index the queue's hot lookup (QUEUED rows per app, RUNNING count per app).
CREATE INDEX "Deployment_appId_status_idx" ON "Deployment" ("appId", "status");
