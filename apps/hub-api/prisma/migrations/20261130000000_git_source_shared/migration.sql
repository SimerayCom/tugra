-- An instance owner can share one Git source with every team (connect GitHub once, import/deploy into any team).
ALTER TABLE "GitSource" ADD COLUMN "sharedAllTeams" BOOLEAN NOT NULL DEFAULT false;
