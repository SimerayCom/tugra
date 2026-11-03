-- Per-app HTTP health-check response-body match (Coolify parity). Additive + nullable: null keeps the
-- current status-only probe, so existing apps are unchanged. When set, the deploy-gate probe also
-- requires this literal substring in the response body (grep -F), on top of the status check.
ALTER TABLE "Application" ADD COLUMN "healthCheckResponseText" TEXT;
