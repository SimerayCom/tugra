-- Log drains (BS8): forward a server's container logs to external HTTP sinks.
CREATE TABLE "LogDrain" (
  "id" TEXT NOT NULL,
  "serverId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "type" TEXT NOT NULL DEFAULT 'HTTP',
  "endpoint" TEXT NOT NULL,
  "authTokenEnc" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LogDrain_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LogDrain_serverId_idx" ON "LogDrain"("serverId");

ALTER TABLE "LogDrain"
  ADD CONSTRAINT "LogDrain_serverId_fkey"
  FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;
