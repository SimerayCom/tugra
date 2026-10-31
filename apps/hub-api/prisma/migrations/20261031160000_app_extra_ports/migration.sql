-- Extra published ports [{hostPort, containerPort, protocol}] beyond the ingress one (classic apps).
ALTER TABLE "Application" ADD COLUMN "extraPorts" JSONB;
