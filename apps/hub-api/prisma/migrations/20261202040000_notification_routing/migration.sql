-- Notification routing: category selection, minimum severity and per-category Telegram topics.
-- Defaults reproduce the previous behaviour (no categories, every severity, no topic map).
ALTER TABLE "NotificationChannel" ADD COLUMN "categories" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "NotificationChannel" ADD COLUMN "minSeverity" TEXT NOT NULL DEFAULT 'info';
ALTER TABLE "NotificationChannel" ADD COLUMN "topics" JSONB;
