-- Auto uptime monitors: link a monitor to an app's domain.
ALTER TABLE "Monitor" ADD COLUMN "appId" TEXT;
ALTER TABLE "Monitor" ADD COLUMN "auto" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "Monitor_appId_idx" ON "Monitor"("appId");
