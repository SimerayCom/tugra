-- Watch paths: glob patterns that gate whether a git push triggers a deploy (empty = deploy on every push).
ALTER TABLE "Application" ADD COLUMN "watchPaths" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
