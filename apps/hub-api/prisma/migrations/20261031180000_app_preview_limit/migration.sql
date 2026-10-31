-- Max concurrent PR previews per app (null = unlimited); a new PR beyond the cap evicts the oldest preview.
ALTER TABLE "Application" ADD COLUMN "previewLimit" INTEGER;
