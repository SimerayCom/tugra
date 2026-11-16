-- PostgreSQL 18+ keeps its data under /var/lib/postgresql/<major>/docker, so Tugra mounts the data volume at /var/lib/postgresql for it.
-- AlterTable
ALTER TABLE "Database" ADD COLUMN     "pgParentMount" BOOLEAN NOT NULL DEFAULT false;

-- A PostgreSQL 18+ database that was never started has no cluster yet: give it the persistent layout right away. A started or FAILED one keeps
-- its mount (switching it would hide the cluster that lives in its anonymous volume) and is flagged by the hub instead; a failed provision can
-- leave a cluster in a dangling anonymous volume, so a missing container proves nothing. The major is read from the IMAGE first (a custom postgres:18 image carries the default
-- version "16"; the official image with a floating tag is the newest major), and from the version only when the image names none.
UPDATE "Database" SET "pgParentMount" = true
WHERE "engine" = 'POSTGRES' AND "status" = 'NEW'
  AND (
    "image" ~* '(^|/)postgres:(1[89]|[2-9][0-9])([.@-]|$)'
    OR "image" ~* '(^|/)postgis:(1[89]|[2-9][0-9])([.@-]|$)'
    OR "image" ~* ':([^:/@]*[-_.])?pg(1[89]|[2-9][0-9])([-_.@]|$)'
    OR "image" ~* '(^|/)postgres(@.*)?$'
    OR "image" ~* '(^|/)postgres:[^0-9:/@][^:/@]*(@.*)?$'
    OR (
      NOT ("image" ~* '(^|/)postgres(:[^:/@]*)?(@.*)?$' OR "image" ~* '(^|/)postgis:[0-9]' OR "image" ~* ':([^:/@]*[-_.])?pg[0-9]{1,2}([-_.@]|$)')
      AND ("version" ~ '^(1[89]|[2-9][0-9])([.-]|$)' OR "version" ~* '^(latest|alpine|bookworm|trixie|bullseye)([.-]|$)')
    )
  );
