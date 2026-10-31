-- DOCKERFILE build: optional multi-stage target stage (docker build --target).
ALTER TABLE "Application" ADD COLUMN "dockerBuildTarget" TEXT;
