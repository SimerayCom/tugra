-- Importer slice L5: a Dokploy project carries a description and tags that Tugra's Project row had no place for.
-- Both are backward-compatible: description is nullable, tags defaults to an empty array (NOT NULL DEFAULT '{}',
-- like the other resource tags columns), so every existing project row is valid unchanged and no backfill is needed.
ALTER TABLE "Project" ADD COLUMN "description" TEXT;
ALTER TABLE "Project" ADD COLUMN "tags" TEXT[] NOT NULL DEFAULT '{}';
