/**
 * Pure builder for the server-wide Docker cleanup command.
 *
 * Scoped and rollback-safe by design. It NEVER runs `docker system prune` and NEVER prunes containers,
 * networks or tagged images, because each of those strands something Tugra still needs:
 *   - `docker system prune`/container prune removes stopped managed containers → a later Start fails.
 *   - `docker network prune` removes a network whose members are all stopped → Start fails "network not found".
 *   - `docker image prune -a` (even age-filtered) removes unused TAGGED images; an app's retained rollback
 *     tags (tugra_<id>:<deployId>) are unused and the `until=` filter keys on the image's *build* date
 *     (an IMAGE app's upstream is often months old), so it would delete rollback targets the DB still lists.
 *
 * App image retention is the hub's job (keep-5 pruneImages per deploy + removal on app delete), NOT this
 * host-wide sweep. So the sweep only reclaims the generic, always-safe hogs:
 *   1. `docker image prune -f`        — dangling (untagged) layers from rebuilds; never a tagged rollback image.
 *   2. `docker builder prune -af`     — BuildKit cache older than the retention window; the big reclaim on a
 *      `--filter until`                 build host (only cost is a slower next build).
 * `volumes` (opt-in, default off) also prunes unused anonymous volumes (`docker volume prune -f` leaves
 * named/managed volumes alone on modern engines) — destructive, so it stays an explicit choice.
 *
 * Steps run best-effort (each `|| rc=1`), so one hiccup (a concurrent prune, an unsupported builder) never
 * aborts the rest; the overall exit is non-zero only if a step actually failed.
 */
const DEFAULT_RETENTION_HOURS = 168; // keep BuildKit cache from the last 7 days (recent apps' build speed)
const MAX_RETENTION_HOURS = 24 * 365;

export function buildCleanupScript({
  volumes,
  retentionHours = DEFAULT_RETENTION_HOURS,
}: {
  volumes: boolean;
  retentionHours?: number;
}): string {
  const hours = Number.isFinite(retentionHours)
    ? Math.min(MAX_RETENTION_HOURS, Math.max(1, Math.floor(retentionHours)))
    : DEFAULT_RETENTION_HOURS;
  const steps = [
    "docker image prune -f",
    `docker builder prune -af --filter until=${hours}h`,
  ];
  if (volumes) steps.push("docker volume prune -f");
  return `rc=0; ${steps.map((s) => `${s} || rc=1`).join("; ")}; exit $rc`;
}
