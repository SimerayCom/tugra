-- Enforce one GitSource per (teamId, appId). The previous create() allowed duplicates, so a deployed DB may
-- already hold some; collapse them FIRST or the CREATE UNIQUE INDEX (run by `migrate deploy` on boot/upgrade)
-- would fail and halt the hub. Keep the oldest row per (teamId, appId); repoint apps off the duplicates (the FK
-- is ON DELETE SET NULL, so a plain delete would silently unlink them) before removing the duplicates. On a
-- clean DB every statement below affects zero rows.

WITH ranked AS (
  SELECT "id",
         first_value("id") OVER (PARTITION BY "teamId", "appId" ORDER BY "createdAt" ASC, "id" ASC) AS keep_id
  FROM "GitSource"
)
UPDATE "Application" a
SET "gitSourceId" = r.keep_id
FROM ranked r
WHERE a."gitSourceId" = r."id" AND r."id" <> r.keep_id;

WITH ranked AS (
  SELECT "id",
         first_value("id") OVER (PARTITION BY "teamId", "appId" ORDER BY "createdAt" ASC, "id" ASC) AS keep_id
  FROM "GitSource"
)
DELETE FROM "GitSource" g
USING ranked r
WHERE g."id" = r."id" AND r."id" <> r.keep_id;

CREATE UNIQUE INDEX "GitSource_teamId_appId_key" ON "GitSource"("teamId", "appId");
