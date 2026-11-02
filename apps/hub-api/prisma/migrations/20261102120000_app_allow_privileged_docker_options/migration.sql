-- Per-app, instance-owner opt-in that lifts the docker-options host-escape denylist. Additive; existing apps stay locked (false).
ALTER TABLE "Application" ADD COLUMN "allowPrivilegedDockerOptions" BOOLEAN NOT NULL DEFAULT false;
