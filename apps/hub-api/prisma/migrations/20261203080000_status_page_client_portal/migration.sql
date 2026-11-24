-- Customer portal: a "portal" custom-role preset (Client) and invitations that carry a custom role.
ALTER TABLE "TeamRole" ADD COLUMN "portal" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "TeamInvitation" ADD COLUMN "teamRoleId" TEXT;
ALTER TABLE "TeamInvitation" ADD CONSTRAINT "TeamInvitation_teamRoleId_fkey" FOREIGN KEY ("teamRoleId") REFERENCES "TeamRole"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Public status page.
CREATE TABLE "StatusPage" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "StatusPage_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StatusPage_teamId_key" ON "StatusPage"("teamId");
CREATE UNIQUE INDEX "StatusPage_slug_key" ON "StatusPage"("slug");
ALTER TABLE "StatusPage" ADD CONSTRAINT "StatusPage_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "StatusPageMonitor" (
    "pageId" TEXT NOT NULL,
    "monitorId" TEXT NOT NULL,
    "label" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "StatusPageMonitor_pkey" PRIMARY KEY ("pageId","monitorId")
);
ALTER TABLE "StatusPageMonitor" ADD CONSTRAINT "StatusPageMonitor_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "StatusPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StatusPageMonitor" ADD CONSTRAINT "StatusPageMonitor_monitorId_fkey" FOREIGN KEY ("monitorId") REFERENCES "Monitor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "StatusMaintenance" (
    "id" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StatusMaintenance_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "StatusMaintenance_pageId_startsAt_idx" ON "StatusMaintenance"("pageId", "startsAt");
ALTER TABLE "StatusMaintenance" ADD CONSTRAINT "StatusMaintenance_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "StatusPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "StatusSubscriber" (
    "id" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StatusSubscriber_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StatusSubscriber_pageId_email_key" ON "StatusSubscriber"("pageId", "email");
ALTER TABLE "StatusSubscriber" ADD CONSTRAINT "StatusSubscriber_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "StatusPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
