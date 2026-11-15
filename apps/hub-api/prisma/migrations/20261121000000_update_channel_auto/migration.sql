-- Self-update channel becomes "automatic" unless the owner pinned one. Until now the column defaulted to
-- 'stable', so a stored 'stable' is indistinguishable from "never chose": make it 'auto'. On a stable build
-- 'auto' still resolves to stable (no change); on a beta build it resolves to beta, which is the whole point —
-- a beta hub left on the default never saw the next beta because the published manifest has no stable entry yet.
-- A stored 'beta' was necessarily an explicit choice (it was never the default) and is kept.
--
-- The column stays NOT NULL with the 'auto' sentinel on purpose: the PREVIOUS hub image reads this row on every
-- request through a client that has `updateChannel` as a required string, so a NULL here would make a rollback
-- of this very upgrade (the sidecar's recover_previous path) throw on every settings read. The old image simply
-- logs `no entry for channel "auto"` and keeps its cache.
ALTER TABLE "InstanceSettings" ALTER COLUMN "updateChannel" SET DEFAULT 'auto';
UPDATE "InstanceSettings" SET "updateChannel" = 'auto' WHERE "updateChannel" = 'stable';

-- Which channel the cached "latest" was read from: a cache left by another channel (the owner pinned Stable on a
-- beta hub) is ignored instead of advertising a beta as an update forever.
ALTER TABLE "InstanceSettings" ADD COLUMN "cachedLatestChannel" TEXT;

-- Last-check bookkeeping for the Updates card + the panel-load stale refresh.
ALTER TABLE "InstanceSettings" ADD COLUMN "updateLastCheckedAt" TIMESTAMP(3),
                               ADD COLUMN "updateLastCheckError" TEXT;
