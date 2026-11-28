-- "Start all": the owner handed the waves of this campaign to the hub, which starts the next one when the earlier ones reached a safe point.
ALTER TABLE "MigrationCampaign" ADD COLUMN "driving" BOOLEAN NOT NULL DEFAULT false;
