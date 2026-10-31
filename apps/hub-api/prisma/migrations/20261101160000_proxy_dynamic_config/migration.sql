-- Operator-authored Traefik dynamic-config files (Coolify "Proxy > Dynamic Configurations" parity).
-- One row per YAML file written to the proxy's /dynamic dir as `user-<name>.yml`.
CREATE TABLE "ProxyDynamicConfig" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProxyDynamicConfig_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProxyDynamicConfig_serverId_name_key" ON "ProxyDynamicConfig"("serverId", "name");
CREATE INDEX "ProxyDynamicConfig_serverId_idx" ON "ProxyDynamicConfig"("serverId");

ALTER TABLE "ProxyDynamicConfig" ADD CONSTRAINT "ProxyDynamicConfig_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;
