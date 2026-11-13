-- PITR replay bookkeeping on Restore (kind PITR): the new database produced, the moment restored to, the base
-- backup used. All nullable + additive; existing rows are untouched.
ALTER TABLE "Restore" ADD COLUMN "targetDatabaseId" TEXT;
ALTER TABLE "Restore" ADD COLUMN "targetTime" TIMESTAMP(3);
ALTER TABLE "Restore" ADD COLUMN "baseBackupId" TEXT;
