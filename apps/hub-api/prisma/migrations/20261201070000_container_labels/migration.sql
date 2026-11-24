-- Allow-listed container labels (Coolify name/resource/project/environment, compose service) per server container,
-- so the dashboard can name a container after its real app and project.
CREATE TABLE "ContainerLabel" (
    "serverId" TEXT NOT NULL,
    "containerName" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "resource" TEXT NOT NULL DEFAULT '',
    "project" TEXT NOT NULL DEFAULT '',
    "environment" TEXT NOT NULL DEFAULT '',
    "service" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContainerLabel_pkey" PRIMARY KEY ("serverId","containerName")
);

CREATE INDEX "ContainerLabel_updatedAt_idx" ON "ContainerLabel"("updatedAt");

ALTER TABLE "ContainerLabel" ADD CONSTRAINT "ContainerLabel_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;
