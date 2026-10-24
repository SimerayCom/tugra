-- Attach a managed Database to an Application so its connection URI is auto-injected into the app's
-- runtime env at deploy time. Additive new table; existing apps/databases are unaffected. The databaseId
-- foreign key is NO ACTION (not CASCADE): deleting a database that still has links is refused at the app
-- layer (409), while a whole-team delete still cascades (NO ACTION is checked at end-of-statement).

-- CreateTable
CREATE TABLE "AppDatabaseLink" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "databaseId" TEXT NOT NULL,
    "envVar" TEXT NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppDatabaseLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AppDatabaseLink_appId_databaseId_key" ON "AppDatabaseLink"("appId", "databaseId");

-- CreateIndex
CREATE UNIQUE INDEX "AppDatabaseLink_appId_envVar_key" ON "AppDatabaseLink"("appId", "envVar");

-- CreateIndex
CREATE INDEX "AppDatabaseLink_databaseId_idx" ON "AppDatabaseLink"("databaseId");

-- AddForeignKey
ALTER TABLE "AppDatabaseLink" ADD CONSTRAINT "AppDatabaseLink_appId_fkey" FOREIGN KEY ("appId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppDatabaseLink" ADD CONSTRAINT "AppDatabaseLink_databaseId_fkey" FOREIGN KEY ("databaseId") REFERENCES "Database"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
