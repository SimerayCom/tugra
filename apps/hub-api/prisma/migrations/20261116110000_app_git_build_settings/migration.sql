CREATE TYPE "SourceCommitMode" AS ENUM ('OFF', 'RUNTIME', 'BUILD');

ALTER TABLE "Application"
  ADD COLUMN "gitSubmodules"        BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "gitLfs"               BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "gitShallowClone"      BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "disableBuildCache"    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "injectEnvAsBuildArgs" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "sourceCommitMode"     "SourceCommitMode" NOT NULL DEFAULT 'RUNTIME';
