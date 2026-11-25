-- Server rows are small in count but wide and updated on every status / host-info / last-seen write. Leave 20% free
-- space per page so those updates stay HOT (same-page, no index churn, cheap to vacuum). Only affects pages written
-- from now on: a metadata-only change (brief SHARE UPDATE EXCLUSIVE lock, no table rewrite).
ALTER TABLE "Server" SET (fillfactor = 80);
