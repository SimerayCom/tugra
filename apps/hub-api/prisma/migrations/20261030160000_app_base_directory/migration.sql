-- Monorepo subdirectory build: the repo-relative directory used as the build context/root. Additive + nullable.
ALTER TABLE "Application" ADD COLUMN "baseDirectory" TEXT;
