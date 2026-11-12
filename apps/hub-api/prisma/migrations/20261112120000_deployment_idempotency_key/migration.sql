-- Durable at-most-once deploy ENQUEUE. When a client sends an Idempotency-Key on POST /apps/:id/deploy, the
-- QUEUED Deployment row carries it, and this unique index is the backstop that survives a Redis flush / hub
-- crash — the in-flight IdempotencyInterceptor only dedupes while Redis is healthy on a single hub (see its
-- docstring, common/idempotency.interceptor.ts). Nullable + scoped by appId: a deploy with no client key stores
-- NULL, and Postgres treats every NULL as DISTINCT (default NULLS DISTINCT — we rely on the default and do NOT
-- emit NULLS NOT DISTINCT), so a compound (appId, NULL) tuple never collides. The no-key path therefore stays
-- unconstrained (today's behavior: many keyless deploys per app remain legal).
-- Backfill: existing Deployment rows get NULL automatically (no default), satisfying the index on creation.
ALTER TABLE "Deployment" ADD COLUMN "idempotencyKey" TEXT;

-- CREATE UNIQUE INDEX (non-CONCURRENTLY) is correct here: it briefly takes an ACCESS EXCLUSIVE lock on
-- Deployment while it builds, but the column is brand-new and entirely NULL (an empty index), so the build is
-- near-instant — and `prisma migrate deploy` runs during a hub update when deploys are paused anyway, so the
-- lock is a non-issue. The index name matches Prisma's default for the schema's @@unique([appId, idempotencyKey])
-- so `prisma migrate diff` reports no drift.
CREATE UNIQUE INDEX "Deployment_appId_idempotencyKey_key" ON "Deployment"("appId", "idempotencyKey");
