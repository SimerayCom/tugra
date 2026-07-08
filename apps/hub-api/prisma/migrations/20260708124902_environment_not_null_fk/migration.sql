/*
  Warnings:

  - Made the column `environmentId` on table `Application` required. This step will fail if there are existing NULL values in that column.
  - Made the column `environmentId` on table `Database` required. This step will fail if there are existing NULL values in that column.

*/

-- Backfill: adopt legacy orphan resources (environmentId IS NULL, created before
-- the create paths resolved a default) into their team's default environment.
-- The prior migration 20260707205418 guarantees every team has exactly one default
-- project with exactly one default env, so this join resolves to exactly one target
-- env per orphan. Must run BEFORE the NOT NULL step below.
UPDATE "Application" a
SET "environmentId" = e.id
FROM "Environment" e
JOIN "Project" pr ON pr.id = e."projectId" AND pr."isDefault"
WHERE e."isDefault" AND pr."teamId" = a."teamId" AND a."environmentId" IS NULL;

UPDATE "Database" d
SET "environmentId" = e.id
FROM "Environment" e
JOIN "Project" pr ON pr.id = e."projectId" AND pr."isDefault"
WHERE e."isDefault" AND pr."teamId" = d."teamId" AND d."environmentId" IS NULL;

-- AlterTable
ALTER TABLE "Application" ALTER COLUMN "environmentId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Database" ALTER COLUMN "environmentId" SET NOT NULL;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Database" ADD CONSTRAINT "Database_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
