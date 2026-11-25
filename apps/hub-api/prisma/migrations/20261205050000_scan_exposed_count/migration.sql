-- Store the exposed-service count of the latest scan beside the report, so server lists (which do not load the report)
-- can show the fleet-wide warning. Backfill from reports already stored; only reports whose host half was checked count.
ALTER TABLE "Server" ADD COLUMN "scanExposedCount" INTEGER;
UPDATE "Server"
SET "scanExposedCount" = jsonb_array_length("scanReport"->'exposed')
WHERE "scanReport" IS NOT NULL
  AND "scanReport"->'host'->>'status' = 'ok'
  AND jsonb_typeof("scanReport"->'exposed') = 'array';
