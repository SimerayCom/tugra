-- Preview deployments (B6): per-PR throwaway clones of a parent app.
ALTER TABLE "Application" ADD COLUMN "isPreview" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Application" ADD COLUMN "previewEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Application" ADD COLUMN "prNumber" INTEGER;
ALTER TABLE "Application" ADD COLUMN "parentAppId" TEXT;

ALTER TABLE "Application"
  ADD CONSTRAINT "Application_parentAppId_fkey"
  FOREIGN KEY ("parentAppId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "Application_parentAppId_idx" ON "Application"("parentAppId");
