-- Traefik forward-auth middleware: protect an app behind an external auth service.
ALTER TABLE "Application" ADD COLUMN "forwardAuth" TEXT;
