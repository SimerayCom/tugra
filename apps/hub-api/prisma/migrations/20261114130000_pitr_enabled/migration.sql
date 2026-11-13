-- PITR (point-in-time recovery) opt-in flag for Postgres databases. Additive and default-off: every existing
-- row keeps PITR disabled, so provisioning stays byte-identical until a database is explicitly switched on in
-- a later slice. pitrEnabledAt records when it was turned on (NULL while off).
ALTER TABLE "Database" ADD COLUMN "pitrEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Database" ADD COLUMN "pitrEnabledAt" TIMESTAMP(3);
