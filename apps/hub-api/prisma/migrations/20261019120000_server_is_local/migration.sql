-- The box the hub runs on, auto-provisioned at first-owner registration on a turnkey single-box install
-- (CASA-INSTALL-2). Additive, defaulted — existing servers are unaffected.
ALTER TABLE "Server" ADD COLUMN "isLocal" BOOLEAN NOT NULL DEFAULT false;
