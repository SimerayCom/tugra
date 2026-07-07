-- AlterTable
ALTER TABLE "Environment" ADD COLUMN     "isDefault" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "isDefault" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: guarantee every team has exactly one default project and every
-- project has exactly one default ("production") environment. Idempotent — each
-- step only fills gaps (NOT EXISTS / no-default) so re-running promotes nothing twice.

-- 1) Teams with no project at all -> create a Default project + production env.
WITH teams_without_project AS (
  SELECT t.id
  FROM "Team" t
  LEFT JOIN "Project" p ON p."teamId" = t.id
  WHERE p.id IS NULL
), new_projects AS (
  INSERT INTO "Project" (id, "teamId", name, "isDefault", "createdAt")
  SELECT gen_random_uuid()::text, id, 'Default', true, now()
  FROM teams_without_project
  RETURNING id
)
INSERT INTO "Environment" (id, "projectId", name, "isDefault", "createdAt")
SELECT gen_random_uuid()::text, id, 'production', true, now()
FROM new_projects;

-- 2) Teams that have projects but none marked default -> mark the oldest project.
UPDATE "Project" p SET "isDefault" = true
WHERE p.id IN (
  SELECT DISTINCT ON (t.id) pr.id
  FROM "Team" t
  JOIN "Project" pr ON pr."teamId" = t.id
  WHERE NOT EXISTS (SELECT 1 FROM "Project" d WHERE d."teamId" = t.id AND d."isDefault")
  ORDER BY t.id, pr."createdAt" ASC
);

-- 3) Projects with no environment at all -> create a default production env.
INSERT INTO "Environment" (id, "projectId", name, "isDefault", "createdAt")
SELECT gen_random_uuid()::text, pr.id, 'production', true, now()
FROM "Project" pr
WHERE NOT EXISTS (SELECT 1 FROM "Environment" e WHERE e."projectId" = pr.id);

-- 4) Every project that has environments but no default -> mark the oldest as default.
UPDATE "Environment" e SET "isDefault" = true
WHERE e.id IN (
  SELECT DISTINCT ON (pr.id) en.id
  FROM "Project" pr
  JOIN "Environment" en ON en."projectId" = pr.id
  WHERE NOT EXISTS (SELECT 1 FROM "Environment" d WHERE d."projectId" = pr.id AND d."isDefault")
  ORDER BY pr.id, en."createdAt" ASC
);
