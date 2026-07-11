-- Grant the new read-only "logs" capability to every existing server so live container-log follow
-- works immediately everywhere (new servers get it from DEFAULT_CAPABILITIES). Additive + idempotent:
-- only servers that don't already have it are touched, so a re-run is a no-op.
UPDATE "Server"
SET "capabilities" = array_append("capabilities", 'logs')
WHERE NOT ('logs' = ANY("capabilities"));
