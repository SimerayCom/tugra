-- Custom Docker run options (raw flags appended to docker run; Coolify parity).
ALTER TABLE "Application" ADD COLUMN "dockerOptions" TEXT;
