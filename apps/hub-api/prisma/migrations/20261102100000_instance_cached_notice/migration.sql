-- Cache the signed top-level operator notice from the update manifest (nullable; additive).
ALTER TABLE "InstanceSettings" ADD COLUMN "cachedNotice" JSONB;
