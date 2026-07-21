-- CreateTable
CREATE TABLE "ServerTunnel" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'cloudflare',
    "cfAccountId" TEXT NOT NULL,
    "zoneName" TEXT NOT NULL,
    "zoneId" TEXT NOT NULL,
    "cfApiTokenEnc" TEXT NOT NULL,
    "tunnelId" TEXT,
    "tunnelName" TEXT NOT NULL,
    "cfTunnelTokenEnc" TEXT,
    "dnsRecordId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServerTunnel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ServerTunnel_serverId_key" ON "ServerTunnel"("serverId");

-- AddForeignKey
ALTER TABLE "ServerTunnel" ADD CONSTRAINT "ServerTunnel_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "Application" ADD COLUMN     "tunnelExposed" BOOLEAN NOT NULL DEFAULT false;
