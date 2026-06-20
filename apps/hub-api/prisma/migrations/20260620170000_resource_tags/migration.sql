-- Resource tags (BS9): free-text labels on apps, servers and databases.
ALTER TABLE "Application" ADD COLUMN "tags" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "Server" ADD COLUMN "tags" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "Database" ADD COLUMN "tags" TEXT[] NOT NULL DEFAULT '{}';
