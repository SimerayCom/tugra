-- "Read this Coolify": read-only inventory of a Coolify instance read through the agent on its host (metadata only, no secrets).
CREATE TABLE "CoolifyInventory" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "enabledById" TEXT NOT NULL,
    "enabledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "coolifyImage" TEXT,
    "snapshot" JSONB,
    "counts" JSONB,
    "readAt" TIMESTAMP(3),
    "readById" TEXT,
    "serverLinks" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CoolifyInventory_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CoolifyInventory_serverId_key" ON "CoolifyInventory"("serverId");

CREATE INDEX "CoolifyInventory_teamId_idx" ON "CoolifyInventory"("teamId");

ALTER TABLE "CoolifyInventory" ADD CONSTRAINT "CoolifyInventory_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CoolifyInventory" ADD CONSTRAINT "CoolifyInventory_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;
