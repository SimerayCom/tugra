-- Tunable health-check timings (seconds; null = built-in default) + an optional exact expected HTTP status.
ALTER TABLE "Application" ADD COLUMN "healthInterval" INTEGER;
ALTER TABLE "Application" ADD COLUMN "healthTimeout" INTEGER;
ALTER TABLE "Application" ADD COLUMN "healthRetries" INTEGER;
ALTER TABLE "Application" ADD COLUMN "healthStartPeriod" INTEGER;
ALTER TABLE "Application" ADD COLUMN "healthExpectedStatus" INTEGER;
