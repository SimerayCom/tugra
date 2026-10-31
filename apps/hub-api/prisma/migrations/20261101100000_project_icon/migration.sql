-- Custom project icon (square PNG), stored off the Project row. Additive/nullable; no backfill.
ALTER TABLE "Project" ADD COLUMN "iconUpdatedAt" TIMESTAMP(3);

CREATE TABLE "ProjectIcon" (
  "projectId" TEXT NOT NULL,
  "mime" TEXT NOT NULL,
  "data" BYTEA NOT NULL,
  "sizeBytes" INTEGER NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProjectIcon_pkey" PRIMARY KEY ("projectId")
);

ALTER TABLE "ProjectIcon" ADD CONSTRAINT "ProjectIcon_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
