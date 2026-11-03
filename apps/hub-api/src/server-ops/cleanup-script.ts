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

/** One row of `docker system df` — docker's own human sizes are surfaced as-is (no re-parsing to bytes). */
export interface DiskUsageRow {
  totalCount: number;
  active: number;
  size: string;
  reclaimable: string;
}
export interface DiskUsage {
  images: DiskUsageRow;
  containers: DiskUsageRow;
  volumes: DiskUsageRow;
  buildCache: DiskUsageRow;
}

/** `docker system df` as one JSON object per line (Images / Containers / Local Volumes / Build Cache). Fixed
 *  command, no user input → no injection surface; single-quoted so the shell leaves the Go-template braces. */
export function buildDiskUsageScript(): string {
  return "docker system df --format '{{json .}}'";
}

const ZERO_ROW: DiskUsageRow = { totalCount: 0, active: 0, size: "0B", reclaimable: "0B" };

/** Parse `docker system df --format '{{json .}}'`. Each line is a JSON object of STRING fields
 *  (TotalCount/Active/Size/Reclaimable; Reclaimable like "800MB (66%)"). Bad lines are skipped and any
 *  missing category defaults to zero, so the result always has all four rows. */
export function parseDiskUsage(output: string): DiskUsage {
  const result: DiskUsage = { images: { ...ZERO_ROW }, containers: { ...ZERO_ROW }, volumes: { ...ZERO_ROW }, buildCache: { ...ZERO_ROW } };
  const byType: Record<string, keyof DiskUsage> = { Images: "images", Containers: "containers", "Local Volumes": "volumes", "Build Cache": "buildCache" };
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const key = typeof obj.Type === "string" ? byType[obj.Type] : undefined;
    if (!key) continue;
    result[key] = {
      totalCount: toInt(obj.TotalCount),
      active: toInt(obj.Active),
      size: typeof obj.Size === "string" ? obj.Size : "0B",
      // drop docker's trailing " (NN%)" from Reclaimable → just the size.
      reclaimable: typeof obj.Reclaimable === "string" ? obj.Reclaimable.replace(/\s*\([^)]*\)\s*$/, "").trim() : "0B",
    };
  }
  return result;
}

function toInt(v: unknown): number {
  const n = parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : 0;
}
