/**
 * Pure builders for a PHYSICAL base backup of a managed Postgres database via pg_basebackup — the base
 * image from which WAL replay (later PITR slices) restores a cluster to a point in time. Unlike the logical
 * dump (backup-script.ts, per-database pg_dump), this is a whole-CLUSTER physical copy: a single
 * self-contained tar (base + the WAL needed for a consistent restore) streamed to the destination.
 *
 * Postgres-only. Runs INSIDE the managed container via `docker exec` (the image ships pg_basebackup beside
 * pg_dump, so the client always matches the server), reusing the shared gzip → gpg → sink pipeline and size
 * capture (buildDumpUploadScript). ZERO agent change: it is just another opaque shell string over the
 * existing "backup" capability, and the tar never rides the exec channel (64KB cap) — only a small size line
 * plus pg_basebackup's -v metadata on stderr.
 */

import { dbContainerName, type DbCredentials, type DbSpec } from "../databases/database-script";
import { BACKUP_DIR, buildDumpUploadScript, readinessPrelude } from "./backup-script";
import { type DestinationSpec } from "./destination";

function shq(v: string): string {
  return `'${v.replaceAll("'", "'\\''")}'`;
}
// Quote a value embedded inside an already single-quoted `sh -c` string.
function shqInner(v: string): string {
  return `'${v.replaceAll("'", "'\\''")}'`;
}

/** Storage namespace for physical bases: a `<dbId>/base` subdir, kept distinct from the logical dumps in the
 *  SAME destination so listing / prune / restore never confuse the two families. */
export function baseNs(dbId: string): string {
  return `${dbId}/base`;
}

/** Final filename for a physical base: `<ts>.basebackup.tar.gz` (+ `.gpg` when the destination encrypts).
 *  Never contains ".dump", so the logical restore sniff (backup-script.ts) can never match it. */
export function baseBackupFilename(ts: string, dest: DestinationSpec): string {
  let f = `${ts}.basebackup.tar.gz`;
  if (dest.encryption.enabled) f += ".gpg";
  return f;
}

/**
 * The pg_basebackup producer: a single self-contained tar to stdout.
 *  -D - -Ft : tar on stdout (the only shape the shared single-stream sink accepts).
 *  -X fetch : the only WAL mode valid with tar-to-stdout (-X stream is rejected for `-D -`); it appends the
 *             WAL needed for a consistent restore INTO the tar, so the base is standalone.
 *  -c fast  : immediate checkpoint (else the default spread checkpoint can burn the timeout).
 *  -w       : never prompt for a password (fail fast on bad auth instead of hanging to the timeout; PGPASSWORD
 *             is still passed, so a scram setup also works).
 *  -v       : prints the start/end WAL LSN + timeline to stderr (captured as best-effort metadata).
 *  No -h    : the local unix socket, matching initdb's `local replication` line for the bootstrap superuser.
 */
export function basebackupProducer(containerName: string, creds: DbCredentials, label: string): string {
  const { username, password } = creds;
  return `docker exec -e PGPASSWORD=${shq(password)} ${containerName} pg_basebackup -U ${shq(username)} -D - -Ft -X fetch -c fast -w -v -l ${shq(label)}`;
}

/**
 * Fail-loud preflight (distinct exit codes) that runs BEFORE the base backup, so a misconfigured or custom
 * image surfaces a clear FAILED row instead of a cryptic pg_basebackup error or a silent bad base:
 *   exit 6 — pg_basebackup missing, or settings unreadable
 *   exit 4 — wal_level=minimal (cannot feed a physical base; needs replica/logical)
 *   exit 7 — extra (non-default) tablespaces (cannot go into a single stdout tar)
 *   exit 5 — LOCAL only: the host disk is clearly short of a (heuristic) estimate of the compressed size
 */
export function basebackupPrelude(containerName: string, creds: DbCredentials, opts: { local: boolean }): string {
  const { username, password, database } = creds;
  const u = shqInner(username);
  const db = shqInner(database);
  const lines: string[] = [];
  // 1. Wait until postgres accepts connections (reuse the logical readiness poll).
  const readiness = readinessPrelude("POSTGRES", containerName, creds);
  if (readiness) lines.push(readiness);
  // 2. The image must ship pg_basebackup (custom / imported images may not).
  lines.push(
    `docker exec ${containerName} sh -c ${shq("command -v pg_basebackup >/dev/null 2>&1")} || { echo "tugra: pg_basebackup is not available in this database image" >&2; exit 6; }`,
  );
  // 3+4. One psql round-trip for wal_level + non-default tablespace count.
  const pf = `SELECT current_setting('wal_level'), (SELECT count(*) FROM pg_tablespace WHERE spcname NOT IN ('pg_default','pg_global'))`;
  const probe = `docker exec -e PGPASSWORD=${shq(password)} ${containerName} psql -U ${u} -d ${db} -tAF, -c ${shqInner(pf)}`;
  lines.push(
    `PF=$(${probe}) || { echo "tugra: could not read postgres settings" >&2; exit 6; }; ` +
      `WAL=$(printf '%s' "$PF" | cut -d, -f1); TBS=$(printf '%s' "$PF" | cut -d, -f2); ` +
      `case "$WAL" in minimal) echo "tugra: wal_level=minimal cannot take a physical base backup; set wal_level=replica" >&2; exit 4;; esac; ` +
      `[ "$TBS" = 0 ] || { echo "tugra: extra tablespaces are not supported by the stdout base backup" >&2; exit 7; }`,
  );
  // 5. LOCAL only: a base is ~full-cluster size on the shared host disk. Refuse ONLY when both numbers are
  //    known AND avail is clearly short of ~half the cluster size (a compression heuristic); S3 streams, so
  //    it skips this. The whole probe is BEST-EFFORT: the script runs under `set -e; set -o pipefail`, so the
  //    df substitution carries `|| true` (a df that fails or lacks a flag must never abort the backup), and
  //    BACKUP_DIR is created first (it may not exist yet on a host's first LOCAL backup — the shared sink only
  //    mkdir's the per-db subdir later, so an un-guarded df on a missing path would exit 1 and kill the run).
  //    df -Pk is POSIX-portable (avail in 1K blocks); GNU-only -B1 is avoided.
  if (opts.local) {
    const sizeQ = "SELECT COALESCE(sum(pg_database_size(datname)),0) FROM pg_database";
    const sizeProbe = `docker exec -e PGPASSWORD=${shq(password)} ${containerName} psql -U ${u} -d ${db} -tAc ${shqInner(sizeQ)}`;
    lines.push(
      `mkdir -p ${BACKUP_DIR}; ` +
        `AVAIL=$(df -Pk ${BACKUP_DIR} 2>/dev/null | awk 'NR==2{print $4}' || true); ` + // KB free, or empty on any df quirk
        `CLUS=$(${sizeProbe} 2>/dev/null || echo 0); ` + // cluster size in bytes, or 0 if unreadable
        `if [ -n "$AVAIL" ] && [ "$CLUS" -gt 0 ] 2>/dev/null && [ "$AVAIL" -lt "$((CLUS/2/1024))" ] 2>/dev/null; then ` +
        `echo "tugra: not enough local disk for a base backup (need ~$((CLUS/2)) bytes free in ${BACKUP_DIR})" >&2; exit 5; fi`,
    );
  }
  return lines.join("\n");
}

/** Build the full base-backup script: preflight → pg_basebackup | gzip | (gpg) → LOCAL file / mc pipe, size last. */
export function buildBaseBackupScript(db: DbSpec, filename: string, dest: DestinationSpec, ts: string): string {
  const container = dbContainerName(db);
  const label = `tugra-${db.id}-${ts}`;
  const prelude = basebackupPrelude(container, db.credentials, { local: dest.type !== "S3" });
  return buildDumpUploadScript(basebackupProducer(container, db.credentials, label), baseNs(db.id), filename, dest, prelude);
}

/**
 * Best-effort parse of pg_basebackup -v stderr for PITR anchor metadata. Nullable — a miss never fails the
 * backup; the authoritative copy lives in backup_label inside the tar (read by a later slice). The size line
 * is produced after the pipe completes, so these -v lines always precede it and `parseSize` is unaffected.
 */
export function parseBaseMeta(output: string): { startLsn: string | null; timeline: number | null } {
  const m = output.match(/write-ahead log start point:\s*([0-9A-Fa-f]+\/[0-9A-Fa-f]+)(?:\s+on timeline\s+(\d+))?/);
  return { startLsn: m ? m[1] : null, timeline: m && m[2] ? Number(m[2]) : null };
}
