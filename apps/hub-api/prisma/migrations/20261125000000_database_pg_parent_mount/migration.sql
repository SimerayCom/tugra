-- PostgreSQL 18+ keeps its data under /var/lib/postgresql/<major>/docker, so Tugra mounts the data volume at /var/lib/postgresql for it.
-- AlterTable
ALTER TABLE "Database" ADD COLUMN     "pgParentMount" BOOLEAN NOT NULL DEFAULT false;

-- A PostgreSQL 18+ database that was never started has no cluster yet: give it the persistent layout right away. A started one keeps its mount
-- (switching it would hide the cluster that lives in its anonymous volume) and is flagged by the hub instead.
UPDATE "Database" SET "pgParentMount" = true
WHERE "engine" = 'POSTGRES' AND "status" = 'NEW'
  AND ("version" ~ '^(1[89]|[2-9][0-9])([.-]|$)' OR ("version" !~ '^[0-9]{1,2}([.-]|$)' AND "image" ~ '(^|/)postgres:(1[89]|[2-9][0-9])([.-]|$)'));
