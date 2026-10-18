-- Executor support for orchestrated bulk operations (the importer executor). All additive.

-- A not-yet-started task abandoned when its operation is cancelled. Safe on PG12+: added here but not
-- used in this migration, so it does not hit the "new enum value used in same transaction" restriction.
ALTER TYPE "BulkTaskStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';

-- Cooperative cancel: the in-flight fan-out reads this before starting each remaining task.
ALTER TABLE "BulkOperation" ADD COLUMN "cancelRequestedAt" TIMESTAMP(3);

-- Idempotency: at most one task per plan item per operation. Legacy command tasks carry a NULL itemRef,
-- and Postgres treats NULLs as distinct, so the existing command fan-out path is unaffected.
CREATE UNIQUE INDEX "BulkTask_opId_itemRef_key" ON "BulkTask"("opId", "itemRef");
