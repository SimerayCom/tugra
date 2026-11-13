/**
 * Pure builders for the PITR enable/disable flow (5.4b): a read-only PREFLIGHT that fails loud before any downtime,
 * a post-recreate VERIFY that proves WAL archiving really works end to end (Postgres → archive_command → host
 * spool), and the spool purge. All run over the existing opaque agent capabilities — no Go-agent change. Each
 * failure is a DISTINCT exit code mapped to an actionable message by {@link pitrExitHint}.
 */

import { type DbCredentials, type DbSpec, dbContainerName, walHostDir, WAL_CONTAINER_DIR } from "../databases/database-script";
import { readinessPrelude } from "./backup-script";

function shq(v: string): string {
  return `'${v.replaceAll("'", "'\\''")}'`;
}
// Quote a value embedded inside an already single-quoted `sh -c` string.
function shqInner(v: string): string {
  return `'${v.replaceAll("'", "'\\''")}'`;
}

/** Minimum free space under /etc/tugra (KB) to arm archiving — the spool lives there. ~1 GiB. */
const MIN_FREE_KB = 1_048_576;
/** How long verify waits for the forced segment to land in the host spool. */
const VERIFY_WAIT_SEC = 60;

/** `psql -tAc "$1"` helper, defined once per script (creds only via PGPASSWORD env, never argv). */
function psqlFn(container: string, creds: DbCredentials): string {
  const { username, password, database } = creds;
  return `P() { docker exec -e PGPASSWORD=${shq(password)} ${container} psql -U ${shq(username)} -d ${shq(database)} -tAc "$1"; }`;
}

function runningCheck(container: string): string {
  return `[ "$(docker inspect -f '{{.State.Running}}' ${container} 2>/dev/null)" = true ] || { echo "tugra: database container is not running" >&2; exit 3; }`;
}

/**
 * PREFLIGHT — read-only apart from a `docker pull`, run BEFORE any mutation so a failure costs no downtime.
 *   exit 3  — container not running (a NEW/STOPPED/FAILED db cannot be probed)
 *   exit 1  — postgres never became ready
 *   exit 6  — settings unreadable (custom image without psql, bad creds)
 *   exit 15 — Postgres < 10 (pg_switch_wal / pg_walfile_name are PG10+)
 *   exit 4  — wal_level=minimal (archive_mode=on refuses to start; we reject rather than silently force replica)
 *   exit 12 — the database ALREADY has its own archive_mode/archive_command (ours would override it silently)
 *   exit 5  — under ~1 GiB free on the /etc/tugra filesystem (where the spool lives)
 *   exit 14 — the spool is not empty (a leftover from an earlier session; never silently mixed or purged)
 *   exit 13 — image pull failed (a registry outage would otherwise strike AFTER the container was removed)
 */
export function buildPitrPreflightScript(db: DbSpec): string {
  const container = dbContainerName(db);
  const spool = walHostDir(db.id);
  const lines: string[] = ["set -e"];
  lines.push(runningCheck(container));
  const readiness = readinessPrelude("POSTGRES", container, db.credentials);
  if (readiness) lines.push(readiness);
  lines.push(psqlFn(container, db.credentials));
  // One round trip; archive_command LAST so a user value containing '|' survives `cut -f5-`.
  const q =
    "SELECT current_setting('server_version_num'), current_setting('wal_level'), current_setting('archive_mode'), current_setting('wal_segment_size'), current_setting('archive_command')";
  lines.push(
    `PF=$(docker exec -e PGPASSWORD=${shq(db.credentials.password)} ${container} psql -U ${shq(db.credentials.username)} -d ${shq(db.credentials.database)} -tAF'|' -c ${shqInner(q)}) || { echo "tugra: could not read postgres settings" >&2; exit 6; }`,
    `VER=$(printf '%s' "$PF" | cut -d'|' -f1); WAL=$(printf '%s' "$PF" | cut -d'|' -f2); AM=$(printf '%s' "$PF" | cut -d'|' -f3); SEG=$(printf '%s' "$PF" | cut -d'|' -f4); AC=$(printf '%s' "$PF" | cut -d'|' -f5-)`,
    `[ "$VER" -ge 100000 ] 2>/dev/null || { echo "tugra: PITR needs Postgres 10 or newer" >&2; exit 15; }`,
    // The hub derives WAL segment names from LSNs with the default 16 MiB segment size (the window, the replay
    // seed and the WAL-aware retention all depend on it). A cluster initdb'd with --wal-segsize=N would make
    // those names wrong, so it is refused up front instead of being mis-anchored later.
    `[ "$SEG" = "16MB" ] || { echo "tugra: wal_segment_size is $SEG; PITR supports the default 16MB only" >&2; exit 16; }`,
    `case "$WAL" in minimal) echo "tugra: wal_level=minimal cannot archive WAL; run ALTER SYSTEM SET wal_level='replica', restart the database, then enable PITR" >&2; exit 4;; esac`,
    // Already archiving with a command that is not ours → refuse (re-enabling our own setup is fine).
    `case "$AM" in on|always) case "$AC" in *${WAL_CONTAINER_DIR}/*) ;; "") ;; *) echo "tugra: this database already has its own archive_command; PITR would override it" >&2; exit 12;; esac;; esac`,
    // Disk: the spool lives under /etc/tugra. df -Pk is POSIX-portable; a df quirk (empty AVAIL) never blocks.
    `mkdir -p /etc/tugra; AVAIL=$(df -Pk /etc/tugra 2>/dev/null | awk 'NR==2{print $4}' || true)`,
    `if [ -n "$AVAIL" ] && [ "$AVAIL" -lt ${MIN_FREE_KB} ] 2>/dev/null; then echo "tugra: under 1 GiB free on /etc/tugra; free disk before enabling PITR" >&2; exit 5; fi`,
    // Spool must be empty (or absent): leftovers would be mixed into the new chain or shipped as stale WAL.
    `if [ -d ${shq(spool)} ] && [ -n "$(ls -A ${shq(spool)} 2>/dev/null)" ]; then echo "tugra: the WAL spool is not empty (leftover from an earlier session); disable PITR with purge first" >&2; exit 14; fi`,
    // Pre-pull so a registry failure aborts BEFORE the recreate removes the running container.
    `docker pull ${shq(db.image)} >/dev/null 2>&1 || { echo "tugra: could not pull ${db.image}" >&2; exit 13; }`,
    `echo "TUGRA_PITR_PREFLIGHT ok wal_level=$WAL"`,
  );
  return lines.join("\n");
}

/**
 * VERIFY — run right after the archiving recreate. "Container RUNNING" is NOT proof (the run script's trailing
 * `docker ps` exits 0 even while postgres crash-loops), so this proves the chain end to end: settings armed →
 * force a WAL switch → the completed segment lands as a FINAL (non-.part) file in the host spool.
 *   exit 3  — container not running (e.g. archive_mode=on with wal_level=minimal refuses to start)
 *   exit 1  — postgres never became ready
 *   exit 4  — settings not armed (archive_mode/wal_level/archive_command not what the recreate should have set)
 *   exit 9  — the archiver reported a failure (pg_stat_archiver.failed_count rose) — archive_command is failing
 *   exit 10 — no archiver progress within the wait (nothing archived, nothing failed)
 *   exit 11 — the archiver says it archived the segment but the host file is missing (bind-mount mis-wiring)
 * Prints `TUGRA_PITR_VERIFY ok wal=<segment>` on success. Baselines are taken INSIDE this script (pg_stat_archiver
 * counters reset on crash recovery, so they are never compared to stored values). The segment name is captured
 * BEFORE the switch: pg_switch_wal() is a no-op on an idle segment and may name the NEXT file.
 */
export function buildPitrVerifyScript(db: DbSpec): string {
  const container = dbContainerName(db);
  const spool = walHostDir(db.id);
  const lines: string[] = ["set -e"];
  lines.push(runningCheck(container));
  const readiness = readinessPrelude("POSTGRES", container, db.credentials);
  if (readiness) lines.push(readiness);
  lines.push(psqlFn(container, db.credentials));
  lines.push(
    // 1. Settings really armed by the recreate.
    `AM=$(P "SELECT current_setting('archive_mode')") || { echo "tugra: could not read postgres settings" >&2; exit 4; }`,
    `WL=$(P "SELECT current_setting('wal_level')"); AC=$(P "SELECT current_setting('archive_command')")`,
    `[ "$AM" = on ] || { echo "tugra: archive_mode is '$AM', expected on" >&2; exit 4; }`,
    `[ "$WL" != minimal ] || { echo "tugra: wal_level is minimal" >&2; exit 4; }`,
    `case "$AC" in *${WAL_CONTAINER_DIR}/*) ;; *) echo "tugra: archive_command is not the PITR spool command" >&2; exit 4;; esac`,
    // 2. Baseline archiver counters (inside this run only).
    `A0=$(P "SELECT archived_count FROM pg_stat_archiver"); F0=$(P "SELECT failed_count FROM pg_stat_archiver")`,
    // 3. Emit a WAL record, capture the CURRENT segment name, then force the switch so it completes + archives.
    `P "SELECT pg_logical_emit_message(true,'tugra','pitr-verify')" >/dev/null`,
    `W=$(P "SELECT pg_walfile_name(pg_current_wal_lsn())")`,
    `P "SELECT pg_switch_wal()" >/dev/null`,
    // 4. Poll for the FINAL file (never *.part) in the host spool; surface archiver failures as they happen.
    `i=0; while [ $i -lt ${VERIFY_WAIT_SEC} ]; do`,
    `  if [ -s ${shq(spool)}/"$W" ]; then echo "TUGRA_PITR_VERIFY ok wal=$W"; exit 0; fi`,
    `  F=$(P "SELECT failed_count FROM pg_stat_archiver" 2>/dev/null || echo "$F0")`,
    `  if [ "$F" -gt "$F0" ] 2>/dev/null; then LF=$(P "SELECT coalesce(last_failed_wal,'') FROM pg_stat_archiver" 2>/dev/null || true); echo "tugra: archive_command failed (last failed wal: $LF)" >&2; exit 9; fi`,
    `  i=$((i+1)); sleep 1`,
    `done`,
    `A=$(P "SELECT archived_count FROM pg_stat_archiver" 2>/dev/null || echo "$A0")`,
    `if [ "$A" -gt "$A0" ] 2>/dev/null; then echo "tugra: postgres archived $W but it is not in the host spool (bind mount not reaching ${spool})" >&2; exit 11; fi`,
    `echo "tugra: no WAL archived within ${VERIFY_WAIT_SEC}s" >&2; exit 10`,
  );
  return lines.join("\n");
}

/** Parse the verify script's success line. Null when the marker is absent (any failure path). */
export function parsePitrVerify(output: string): { wal: string } | null {
  const m = output.match(/^TUGRA_PITR_VERIFY ok wal=(\S+)$/m);
  return m ? { wal: m[1] } : null;
}

/** Remove the per-db host WAL spool (idempotent). Only ever called when nothing is archiving into it and its
 *  contents are known-disposable (a failed enable attempt, or an explicit purge on disable). */
export function buildWalSpoolPurgeScript(dbId: string): string {
  return `rm -rf ${shq(walHostDir(dbId))} 2>/dev/null || true`;
}

/** Actionable, user-facing message for a preflight/verify exit code (falls back to a generic line). */
export function pitrExitHint(exitCode: number | null, phase: "preflight" | "verify"): string {
  const common: Record<number, string> = {
    1: "Postgres did not become ready in time.",
    3: "The database container is not running.",
    4:
      phase === "preflight"
        ? "wal_level is 'minimal'. Run ALTER SYSTEM SET wal_level = 'replica', restart the database, then enable PITR again."
        : "Archiving settings were not applied after the restart.",
    6: "Could not read Postgres settings (custom image without psql, or bad credentials).",
  };
  const preflight: Record<number, string> = {
    5: "Under 1 GiB of free disk on /etc/tugra. Free space before enabling PITR.",
    12: "This database already has its own archive_command configured; PITR would override it.",
    13: "The database image could not be pulled from its registry.",
    14: "The WAL spool is not empty (left over from an earlier session). Disable PITR with purge first.",
    15: "PITR needs Postgres 10 or newer.",
    16: "This cluster uses a non-default WAL segment size; PITR supports the default 16MB only.",
  };
  const verify: Record<number, string> = {
    9: "archive_command is failing inside the container (see the tail for the last failed segment).",
    10: "No WAL segment was archived within 60s.",
    11: "Postgres archived a segment but it did not appear in the host spool (bind mount not reaching the agent).",
  };
  const table = { ...common, ...(phase === "preflight" ? preflight : verify) };
  return (exitCode != null && table[exitCode]) || `PITR ${phase} failed (exit ${exitCode ?? "?"}).`;
}
