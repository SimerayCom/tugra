-- Custom database icon (square PNG), stored off the Database row. Additive/nullable; no backfill.
ALTER TABLE "Database" ADD COLUMN "iconUpdatedAt" TIMESTAMP(3);

CREATE TABLE "DatabaseIcon" (
  "databaseId" TEXT NOT NULL,
  "mime" TEXT NOT NULL,
  "data" BYTEA NOT NULL,
  "sizeBytes" INTEGER NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DatabaseIcon_pkey" PRIMARY KEY ("databaseId")
);

ALTER TABLE "DatabaseIcon" ADD CONSTRAINT "DatabaseIcon_databaseId_fkey"
  FOREIGN KEY ("databaseId") REFERENCES "Database"("id") ON DELETE CASCADE ON UPDATE CASCADE;
