-- Backfill legacy servers (which predate the capability grant model, so their `capabilities`
-- landed as an empty array from the ADD COLUMN default) to the FULL capability set. This lets
-- the hub enforce an empty array as "deny all" (fail-safe) rather than "allow all" (fail-open):
-- without the backfill, switching enforcement to fail-safe would strand every existing server.
-- New servers are created with an explicit default (all-except-terminal) by the API, so this
-- only ever touches truly-legacy rows and is a one-time, idempotent data migration.
UPDATE "Server"
SET "capabilities" = ARRAY['deploy','database','backup','cleanup','bulk','terminal','schedule','patch']::TEXT[]
WHERE "capabilities" = ARRAY[]::TEXT[];
