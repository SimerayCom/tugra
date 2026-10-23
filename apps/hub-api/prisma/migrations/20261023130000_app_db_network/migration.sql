-- Opt-in flag: also attach this app to the node-local managed-DB network (tugra-net) at deploy,
-- so a migrated/native app resolves its database by the container name tugra_db_<id>. Additive,
-- default false — existing apps are unaffected and deploy byte-identically.
ALTER TABLE "Application" ADD COLUMN "dbNetwork" BOOLEAN NOT NULL DEFAULT false;
