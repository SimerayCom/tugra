-- Scheduled restore-verify drill fields (all additive, nullable/defaulted → non-locking ADD COLUMN, no backfill).
ALTER TABLE "Database" ADD COLUMN "verifyEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Database" ADD COLUMN "verifyIntervalHours" INTEGER;
ALTER TABLE "Database" ADD COLUMN "verifyCron" TEXT;
ALTER TABLE "Database" ADD COLUMN "lastVerifiedAt" TIMESTAMP(3);
