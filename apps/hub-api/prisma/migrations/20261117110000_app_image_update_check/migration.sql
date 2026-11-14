-- Per-app "image update available" check (IMAGE apps): opt-out flag + last upstream digest verdict.
ALTER TABLE "Application" ADD COLUMN     "imageUpdateCheck" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "imageUpstreamDigest" TEXT,
ADD COLUMN     "imageUpstreamCheckedAt" TIMESTAMP(3),
ADD COLUMN     "imageUpstreamChangedAt" TIMESTAMP(3),
ADD COLUMN     "imageCheckError" TEXT,
ADD COLUMN     "imageCheckFailures" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "imageUpdateNotifiedDigest" TEXT;
