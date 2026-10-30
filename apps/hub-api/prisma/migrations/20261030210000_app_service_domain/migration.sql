-- Per-service domains for COMPOSE apps: route a named compose service to its own hostname.
CREATE TABLE "AppServiceDomain" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AppServiceDomain_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AppServiceDomain_hostname_key" ON "AppServiceDomain"("hostname");
CREATE INDEX "AppServiceDomain_applicationId_idx" ON "AppServiceDomain"("applicationId");

ALTER TABLE "AppServiceDomain" ADD CONSTRAINT "AppServiceDomain_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;
