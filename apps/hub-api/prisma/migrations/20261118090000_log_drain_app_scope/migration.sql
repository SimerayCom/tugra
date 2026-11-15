-- D7: per-app log drains, container filter, per-transport options, egress policy.
ALTER TABLE "LogDrain"
  ADD COLUMN "appId" TEXT,
  ADD COLUMN "containers" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "options" JSONB,
  ADD COLUMN "allowPrivate" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "LogDrain_appId_idx" ON "LogDrain"("appId");

ALTER TABLE "LogDrain"
  ADD CONSTRAINT "LogDrain_appId_fkey"
  FOREIGN KEY ("appId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;
