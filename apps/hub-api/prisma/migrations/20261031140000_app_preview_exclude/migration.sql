-- Env var names dropped from a PR preview's copied env (so prod secrets never leak into a preview).
ALTER TABLE "Application" ADD COLUMN "previewExcludeKeys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
