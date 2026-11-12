-- Post-cutover soak (ROLLING path): seconds to keep the PREVIOUS container (stopped, renamed <name>__prev)
-- after the health gate passes and traffic switches, while re-probing the NEW container. A sustained failure
-- in that window auto-reverts to the previous version; staying healthy GCs __prev. 0 = off.
--
-- NOT NULL DEFAULT 0 so every existing Application row migrates to "soak off" and no current deploy gains any
-- added latency or behaviour change (the generated rolling script stays byte-identical when the value is 0).
-- An ADD COLUMN ... DEFAULT on Postgres 11+ is a metadata-only change (no table rewrite), so the ACCESS
-- EXCLUSIVE lock is near-instant — and `prisma migrate deploy` runs during a hub update when deploys are
-- paused anyway.
ALTER TABLE "Application" ADD COLUMN "postCutoverSoakSec" INTEGER NOT NULL DEFAULT 0;
