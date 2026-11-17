-- CreateTable
CREATE TABLE "ServerReboot" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'STARTING',
    "scheduledAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "agentBackAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "result" TEXT,
    "snapshot" JSONB,
    "report" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServerReboot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ServerReboot_serverId_createdAt_idx" ON "ServerReboot"("serverId", "createdAt");

-- CreateIndex
CREATE INDEX "ServerReboot_state_idx" ON "ServerReboot"("state");

-- At most one live (not yet DONE) reboot per server: the DB-level backstop for the service's own check.
CREATE UNIQUE INDEX "server_reboot_one_active_per_server" ON "ServerReboot"("serverId") WHERE "state" <> 'DONE';

-- AddForeignKey
ALTER TABLE "ServerReboot" ADD CONSTRAINT "ServerReboot_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;
