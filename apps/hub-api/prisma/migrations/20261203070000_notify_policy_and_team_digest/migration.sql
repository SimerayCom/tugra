-- Notification delivery policy per channel (quiet hours, rate limit, repeat window) and the opt-in weekly team digest.
ALTER TABLE "NotificationChannel" ADD COLUMN "policy" JSONB;

CREATE TABLE "TeamDigest" (
    "teamId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "channelId" TEXT,
    "lastSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamDigest_pkey" PRIMARY KEY ("teamId")
);

ALTER TABLE "TeamDigest" ADD CONSTRAINT "TeamDigest_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TeamDigest" ADD CONSTRAINT "TeamDigest_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "NotificationChannel"("id") ON DELETE SET NULL ON UPDATE CASCADE;
