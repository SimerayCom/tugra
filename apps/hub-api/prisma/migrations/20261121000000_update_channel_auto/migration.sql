-- Self-update channel becomes "automatic" (NULL) unless the owner pinned one. Until now the column defaulted to
-- 'stable', so a stored 'stable' is indistinguishable from "never chose": NULL it. On a stable build NULL still
-- resolves to stable (no change); on a beta build it resolves to beta, which is the whole point — a beta hub
-- left on the default never saw the next beta because the published manifest has no stable entry yet.
-- A stored 'beta' was necessarily an explicit choice (it was never the default) and is kept.
ALTER TABLE "InstanceSettings" ALTER COLUMN "updateChannel" DROP NOT NULL,
                               ALTER COLUMN "updateChannel" DROP DEFAULT;
UPDATE "InstanceSettings" SET "updateChannel" = NULL WHERE "updateChannel" = 'stable';

-- Last-check bookkeeping for the Updates card + the panel-load stale refresh.
ALTER TABLE "InstanceSettings" ADD COLUMN "updateLastCheckedAt" TIMESTAMP(3),
                               ADD COLUMN "updateLastCheckError" TEXT;
