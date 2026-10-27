-- Host directory bind-mounts for an app ([{hostPath, containerPath, readOnly}], validated vs the sensitive-path denylist).
ALTER TABLE "Application" ADD COLUMN "hostMounts" JSONB;
