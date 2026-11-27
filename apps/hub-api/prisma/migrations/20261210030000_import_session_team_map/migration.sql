-- The owner's Coolify team to Tugra team mapping for an agent import session: { <coolify team ref>: <tugra team id> | null }; ids only.
ALTER TABLE "ImportSession" ADD COLUMN "teamMap" JSONB;
