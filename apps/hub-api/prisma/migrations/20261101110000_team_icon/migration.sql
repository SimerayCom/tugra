-- Custom team icon (square PNG), stored off the Team row. Additive/nullable; no backfill.
ALTER TABLE "Team" ADD COLUMN "iconUpdatedAt" TIMESTAMP(3);

CREATE TABLE "TeamIcon" (
  "teamId" TEXT NOT NULL,
  "mime" TEXT NOT NULL,
  "data" BYTEA NOT NULL,
  "sizeBytes" INTEGER NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TeamIcon_pkey" PRIMARY KEY ("teamId")
);

ALTER TABLE "TeamIcon" ADD CONSTRAINT "TeamIcon_teamId_fkey"
  FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
