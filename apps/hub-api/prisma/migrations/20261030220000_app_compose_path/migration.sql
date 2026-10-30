-- COMPOSE-from-git: the compose file lives in the cloned repo at this repo-relative path
-- (with source=COMPOSE + gitUrl) instead of being stored inline in composeFile. Nullable; the two
-- are mutually exclusive and composePath != NULL discriminates a git-sourced compose stack.
ALTER TABLE "Application" ADD COLUMN "composePath" TEXT;
