-- The actor-scoped audit list (GET /audit) and the Pro audit export both filter by
-- `WHERE actor IN (...) ORDER BY createdAt DESC`. Without an (actor, createdAt) index that is a scan of the
-- whole audit table; this index makes it an index-driven bounded read. Additive, non-destructive.

-- CreateIndex
CREATE INDEX "AuditLog_actor_createdAt_idx" ON "AuditLog"("actor", "createdAt");
