-- Per-app HTTP health-check method + scheme (Coolify parity). Both additive + nullable: null keeps the
-- current behaviour (GET over plain HTTP), so existing apps are unchanged. "https" probes over TLS with
-- certificate verification skipped (-k) for self-signed/internal endpoints. A POST-only or HTTPS-only
-- health endpoint can now be checked without the CMD workaround.
ALTER TABLE "Application" ADD COLUMN "healthCheckMethod" TEXT;
ALTER TABLE "Application" ADD COLUMN "healthCheckScheme" TEXT;
