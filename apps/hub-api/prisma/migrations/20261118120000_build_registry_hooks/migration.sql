-- Custom pushed image name + alias tag, COMPOSE hook service, inline Dockerfile. All nullable: existing rows unchanged.
ALTER TABLE "Application" ADD COLUMN     "composeHookService" TEXT,
ADD COLUMN     "inlineDockerfile" TEXT,
ADD COLUMN     "pushImageName" TEXT,
ADD COLUMN     "pushImageTag" TEXT;

CREATE UNIQUE INDEX "Application_registryId_pushImageName_key" ON "Application"("registryId", "pushImageName");
