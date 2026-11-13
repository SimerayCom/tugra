/**
 * Pure builders + helpers for PITR REPLAY (5.6): restore a Postgres database to a point in time into a NEW
 * database from a physical base backup (5.3) plus the shipped WAL chain (5.5). Everything here is a string
 * builder or a pure function — no I/O — so it is unit-tested without an agent or a live Postgres. All scripts
 * run over the existing opaque agent capabilities (no Go-agent change); secrets ride only in env (MC_HOST,
 * PGPASSWORD) and are scrubbed from any stored output by the orchestrator.
 *
 * Flow the orchestrator drives with these pieces:
 *   list objects → pick base + contiguous WAL run → prepare staging dir → stage segments → seed the data volume
 *   from the base tar → start the container in recovery (database-script recovery args) → wait for promote.
 */

import { type DbCredentials, type DbSpec, dbContainerName, dbVolumeName, ENGINES, walRestoreHostDir } from "../databases/database-script";
import { backupDir, decodeChain, storedObjectSourceCmd } from "./backup-script";
import { baseNs } from "./base-backup-script";
import { isShippableWalName, walNs, walObjectName } from "./wal-ship-script";
import { MC_INSTALL, mcHostEnv, mcTarget, type DestinationSpec } from "./destination";

function shq(v: string): string {
  return `'${v.replaceAll("'", "'\\''")}'`;
}

/** Default WAL segment size (16 MiB). Postgres can be built/initdb'd with another size — the seed script
 *  cross-checks the derived start segment against backup_label and refuses on a mismatch. */
export const WAL_SEGMENT_BYTES = 16 * 1024 * 1024;
/** Max staged segments per replay (64 GiB of WAL) — a bound on disk and time, not a correctness limit. */
export const MAX_STAGE_SEGMENTS = 4096;
/** Objects listed per page. The agent keeps only the FIRST 64KB of a command's output and the page TRAILER comes
 *  last (a missing trailer = unknown, never "empty"), so a page must never approach the cap: the widest S3 row is
 *  `OBJ <24hex>.gz.gpg <8-digit size> <RFC3339 ms lastModified>` ≈ 70 bytes → 400 rows ≈ 28KB. */
export const WAL_LIST_PAGE = 400;
/** Worst-case bytes per listing row (see WAL_LIST_PAGE). Exported so a spec can pin page × row < the 64KB cap. */
export const WAL_LIST_ROW_MAX_BYTES = 72;
/** Segments per staging command (each is a download; keeps one command under its timeout and output cap). */
export const WAL_STAGE_BATCH = 100;

const hex8 = (n: number) => n.toString(16).toUpperCase().padStart(8, "0");

/** Parse a Postgres LSN "X/Y" (hex halves) into its 32-bit halves. Null when malformed. */
export function parseLsn(lsn: string): { hi: number; lo: number } | null {
  const m = /^([0-9A-Fa-f]{1,8})\/([0-9A-Fa-f]{1,8})$/.exec(lsn.trim());
  if (!m) return null;
  return { hi: parseInt(m[1], 16), lo: parseInt(m[2], 16) };
}

/** The WAL segment file name that contains `lsn` on `timeline` (default 16 MiB segments):
 *  TTTTTTTT XXXXXXXX SSSSSSSS = timeline · lsn high word · (lsn low word / segment size). */
export function walSegmentName(lsn: string, timeline: number): string | null {
  const p = parseLsn(lsn);
  if (!p || !Number.isInteger(timeline) || timeline < 1) return null;
  return `${hex8(timeline)}${hex8(p.hi)}${hex8(Math.floor(p.lo / WAL_SEGMENT_BYTES))}`;
}

/** Split a 24-hex segment name into its parts. Null for anything that is not a segment name. */
export function parseSegmentName(name: string): { timeline: number; hi: number; seg: number } | null {
  if (!/^[0-9A-F]{24}$/.test(name)) return null;
  return { timeline: parseInt(name.slice(0, 8), 16), hi: parseInt(name.slice(8, 16), 16), seg: parseInt(name.slice(16, 24), 16) };
}

/** The segment that follows `name` on the same timeline (low part wraps at 256 segments per high word). */
export function nextSegmentName(name: string): string | null {
  const p = parseSegmentName(name);
  if (!p) return null;
  const perHi = 0x100000000 / WAL_SEGMENT_BYTES; // 256 for 16 MiB
  const seg = p.seg + 1;
  return seg >= perHi ? `${hex8(p.timeline)}${hex8(p.hi + 1)}${hex8(0)}` : `${hex8(p.timeline)}${hex8(p.hi)}${hex8(seg)}`;
}

export interface WalObject {
  name: string; // the Postgres file name (segment / .history), suffixes already stripped
  size: number;
  mtime: Date; // object modification time = SHIP time (an upper bound on the records it holds)
}

/**
 * The maximal CONTIGUOUS run of segments starting at `startSeg` present in `objects` (same timeline, no gap).
 * Empty when the start segment itself is missing — the base is then unusable (its WAL was never shipped).
 */
export function contiguousRun(startSeg: string, objects: ReadonlyArray<WalObject>): WalObject[] {
  const byName = new Map(objects.map((o) => [o.name, o]));
  const run: WalObject[] = [];
  let cur: string | null = startSeg;
  while (cur && byName.has(cur) && run.length < MAX_STAGE_SEGMENTS) {
    run.push(byName.get(cur)!);
    cur = nextSegmentName(cur);
  }
  return run;
}

export interface BaseCandidate {
  id: string;
  createdAt: Date; // backup START
  completedAt: Date | null; // backup END — the earliest consistent recovery point
  startLsn: string | null;
  timeline: number | null;
}

export interface BasePick {
  base: BaseCandidate;
  startSeg: string;
  run: WalObject[];
  /** Upper bound of recoverable time from this base = ship time of the last contiguous segment. */
  reach: Date;
}

/** Per-base recoverable interval: [completedAt, reach]. Bases with no start segment / no WAL are excluded. */
export function baseIntervals(bases: ReadonlyArray<BaseCandidate>, objects: ReadonlyArray<WalObject>): BasePick[] {
  const out: BasePick[] = [];
  for (const b of bases) {
    if (!b.completedAt || !b.startLsn || b.timeline == null) continue;
    const startSeg = walSegmentName(b.startLsn, b.timeline);
    if (!startSeg) continue;
    const run = contiguousRun(startSeg, objects);
    if (run.length === 0) continue;
    const reach = run[run.length - 1].mtime;
    if (reach < b.completedAt) continue;
    out.push({ base: b, startSeg, run, reach });
  }
  return out;
}

/** The newest usable base whose interval covers `target` (completedAt ≤ target ≤ reach). Null when none. */
export function pickBase(bases: ReadonlyArray<BaseCandidate>, objects: ReadonlyArray<WalObject>, target: Date): BasePick | null {
  const usable = baseIntervals(bases, objects).filter((p) => p.base.completedAt! <= target && target <= p.reach);
  usable.sort((a, b) => b.base.createdAt.getTime() - a.base.createdAt.getTime());
  return usable[0] ?? null;
}

/** Overall window: earliest = min completedAt, latest = max reach over usable bases. Nulls when none. */
export function recoverableWindow(picks: ReadonlyArray<BasePick>): { earliest: Date | null; latest: Date | null } {
  if (picks.length === 0) return { earliest: null, latest: null };
  const earliest = new Date(Math.min(...picks.map((p) => p.base.completedAt!.getTime())));
  const latest = new Date(Math.max(...picks.map((p) => p.reach.getTime())));
  return { earliest, latest };
}

// ── listing the shipped WAL objects ──

/**
 * List WAL objects for `srcId` at `dest`, one page: `OBJ <name> <size> <mtime>` rows sorted by name, after the
 * cursor `after` (exclusive), at most `limit` rows, then the trailer `TUGRA_WAL_OBJ n=<rows> more=<0|1> last=<name>`.
 * Names are the stored object names (with .gz[.gpg]); the hub strips + re-validates them. LOCAL enumerates with a
 * glob and rejects symlinks/metacharacters (as the spool list does); S3 uses `mc ls --json`. Read-only.
 */
export function buildWalObjectListScript(srcId: string, dest: DestinationSpec, opts: { after?: string; limit?: number } = {}): string {
  const limit = Math.max(1, Math.min(opts.limit ?? WAL_LIST_PAGE, WAL_LIST_PAGE));
  const after = opts.after ?? "";
  const ns = walNs(srcId);
  // sort by name (field 2), apply the cursor + limit, and ALWAYS end with the trailer.
  const page =
    `sort -k2,2 | awk -v a=${shq(after)} -v n=${limit} 'BEGIN{c=0;m=0;l=""} $2>a { if (c<n) {print; c++; l=$2} else {m=1} } ` +
    `END{print "TUGRA_WAL_OBJ n=" c " more=" m " last=" l}'`;
  if (dest.type === "S3" && dest.s3) {
    const target = `${mcTarget(dest.s3, ns, "")}/`;
    // Extract key/size/lastModified from each JSON line regardless of field order; drop non-file rows.
    const extract =
      `awk '{k="";s=0;t=""; if (match($0,/"key":"[^"]*"/)) {k=substr($0,RSTART+7,RLENGTH-8)} ` +
      `if (match($0,/"size":[0-9]+/)) {s=substr($0,RSTART+7,RLENGTH-7)} ` +
      `if (match($0,/"lastModified":"[^"]*"/)) {t=substr($0,RSTART+16,RLENGTH-17)} ` +
      `if (k!="" && index(k,"/")==0) print "OBJ " k " " s " " t}'`;
    // Capture mc's own exit status: a failed/unreachable listing must NOT fall through to the awk END trailer and
    // read as "empty" (no trailer → the hub treats the page as UNKNOWN and retries later).
    return [
      MC_INSTALL,
      `OUT=$(${mcHostEnv(dest.s3)} mc ls --json ${target} 2>/dev/null) || { echo "tugra: could not list the WAL objects at the destination" >&2; exit 1; }`,
      `printf '%s\\n' "$OUT" | ${extract} | ${page}`,
    ].join("\n");
  }
  const dir = backupDir(ns);
  return [
    `dir=${shq(dir)}`,
    `[ -d "$dir" ] || { echo "TUGRA_WAL_OBJ n=0 more=0 last="; exit 0; }`,
    `cd "$dir" || { echo "TUGRA_WAL_OBJ n=0 more=0 last="; exit 0; }`,
    `for f in *; do`,
    `  [ -e "$f" ] || continue`,
    `  [ -f "$f" ] && [ ! -L "$f" ] || continue`,
    `  case "$f" in *[!0-9A-Za-z.]*) continue;; esac`,
    `  echo "OBJ $f $(stat -c %s "$f" 2>/dev/null || echo 0) $(stat -c %Y "$f" 2>/dev/null || echo 0)"`,
    `done | ${page}`,
  ].join("\n");
}

/** Parse one listing page. Null when the trailer is missing (truncated/dead listing — never read as empty).
 *  Object names are stripped of exactly the shipper's suffix for `dest` and re-validated against the WAL
 *  allow-list on the hub; `.backup` label files are dropped (not needed for replay). */
export function parseWalObjects(output: string, dest: DestinationSpec): { objects: WalObject[]; more: boolean; last: string } | null {
  const suffix = dest.encryption.enabled ? ".gz.gpg" : ".gz";
  const objects: WalObject[] = [];
  let trailer: { more: boolean; last: string } | null = null;
  for (const line of output.split("\n")) {
    const row = /^OBJ (\S+) (\d+) (\S*)$/.exec(line);
    if (row) {
      const stored = row[1];
      if (!stored.endsWith(suffix)) continue;
      const name = stored.slice(0, -suffix.length);
      if (!isShippableWalName(name) || name.endsWith(".backup")) continue;
      const raw = row[3];
      const mtime = /^\d+$/.test(raw) ? new Date(Number(raw) * 1000) : new Date(raw);
      if (Number.isNaN(mtime.getTime())) continue;
      objects.push({ name, size: Number(row[2]), mtime });
      continue;
    }
    const t = /^TUGRA_WAL_OBJ n=(\d+) more=([01]) last=(\S*)$/.exec(line);
    if (t) trailer = { more: t[2] === "1", last: t[3] };
  }
  if (!trailer) return null;
  objects.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { objects, more: trailer.more, last: trailer.last };
}

// ── staging ──

/**
 * PREPARE the host staging dir for target `newId`: pull the image, refuse an image whose PGDATA is not the data
 * dir we mount (PG18+ moved it; exit 22), resolve the image's postgres uid/gid BY NAME (999 debian / 70 alpine),
 * require free disk for `segments` (16 MiB each + 1 GiB; exit 24), then (re)create the dir owned by that uid,
 * mode 0700 (raw customer WAL). Files are later written by root (0644) inside it, so the recovering container
 * reads them with no post-start chown (which would race recovery).
 */
export function buildPitrPrepareScript(newId: string, image: string, segments: number): string {
  const dir = walRestoreHostDir(newId);
  const dataDir = ENGINES.POSTGRES.dataDir;
  const needKb = Math.ceil((segments * WAL_SEGMENT_BYTES) / 1024) + 1_048_576;
  return [
    "set -e",
    `IMG=${shq(image)}`,
    `docker pull "$IMG" >/dev/null 2>&1 || { echo "tugra: could not pull ${image}" >&2; exit 13; }`,
    `PGD=$(docker run --rm --entrypoint sh "$IMG" -c 'printenv PGDATA' 2>/dev/null || true)`,
    `[ "$PGD" = ${shq(dataDir)} ] || { echo "tugra: image data dir is '$PGD', expected ${dataDir}" >&2; exit 22; }`,
    `U=$(docker run --rm --entrypoint id "$IMG" -u postgres) && G=$(docker run --rm --entrypoint id "$IMG" -g postgres) || { echo "tugra: image has no postgres user" >&2; exit 21; }`,
    `mkdir -p /etc/tugra; AVAIL=$(df -Pk /etc/tugra 2>/dev/null | awk 'NR==2{print $4}' || true)`,
    `if [ -n "$AVAIL" ] && [ "$AVAIL" -lt ${needKb} ] 2>/dev/null; then echo "tugra: not enough free disk to stage ${segments} WAL segment(s) (need ~${Math.ceil(needKb / 1024)} MiB under /etc/tugra)" >&2; exit 24; fi`,
    `rm -rf ${shq(dir)} && mkdir -p ${shq(dir)} && chown "$U:$G" ${shq(dir)} && chmod 700 ${shq(dir)}`,
    `echo "TUGRA_PITR_PREPARE ok uid=$U gid=$G"`,
  ].join("\n");
}

/**
 * STAGE a batch of segments (already allow-list-validated by the caller — they are spliced into a root shell):
 * each is downloaded → [gpg -d] → gunzip into `<dir>/<name>.part` and renamed on success (resumable: a present
 * non-empty file is skipped). Stop at the FIRST failure so the staged set is always a contiguous prefix. Output
 * is one marker per segment; per-segment stderr is silenced (64KB cap) — the hub names the failed segment.
 */
export function buildWalStageScript(srcId: string, newId: string, names: ReadonlyArray<string>, dest: DestinationSpec): string {
  const dir = walRestoreHostDir(newId);
  const lines: string[] = [];
  if (dest.type === "S3" && dest.s3) lines.push(MC_INSTALL);
  for (const name of names) {
    if (!isShippableWalName(name)) throw new Error(`refusing to stage an invalid WAL name: ${name}`);
    const out = `${dir}/${name}`;
    const fetch = decodeChain(dest, storedObjectSourceCmd(dest, walNs(srcId), walObjectName(name, dest)), { gzip: true });
    lines.push(
      `if [ -s ${shq(out)} ]; then echo "TUGRA_WAL_STAGED ${name}"; else`,
      `  ( set -e; set -o pipefail; ${fetch} > ${shq(`${out}.part`)} ) 2>/dev/null`,
      `  rc=$?`,
      `  if [ "$rc" -eq 0 ] && mv ${shq(`${out}.part`)} ${shq(out)}; then echo "TUGRA_WAL_STAGED ${name}"; else rm -f ${shq(`${out}.part`)}; echo "TUGRA_WAL_STAGE_FAIL ${name}"; exit 1; fi`,
      `fi`,
    );
  }
  return lines.join("\n");
}

export function parseWalStaged(output: string): { staged: string[]; failed: string | null } {
  const staged: string[] = [];
  let failed: string | null = null;
  for (const line of output.split("\n")) {
    const ok = /^TUGRA_WAL_STAGED (\S+)$/.exec(line);
    if (ok) staged.push(ok[1]);
    const bad = /^TUGRA_WAL_STAGE_FAIL (\S+)$/.exec(line);
    if (bad) failed = bad[1];
  }
  return { staged, failed };
}

// ── seeding the data volume from the base tar ──

/**
 * SEED the new database's data volume from the base backup tar (a single pg_basebackup -Ft stream): create the
 * named volume (the normal run script simply reuses an existing one), refuse a non-empty volume (exit 20 — a retry
 * must never extract on top of a half-seeded cluster), then stream download → [gpg -d] → gunzip into a helper
 * container of the DB's OWN image (has tar + resolves the postgres user by name) that extracts into the data dir,
 * fixes ownership/mode (pg_basebackup tars carry fixed ids and no root entry; Postgres refuses 0755), creates
 * recovery.signal, and PROVES the cluster: backup_label present (exit 21), PG_VERSION major matches the source
 * (exit 21), and backup_label's START WAL LOCATION names the segment we derived from startLsn (exit 23 — catches
 * a non-default segment size or a bad startLsn before any WAL is replayed). backup_label is never deleted.
 */
export function buildPitrSeedScript(
  newDb: { id: string; image: string },
  base: { filename: string },
  srcId: string,
  dest: DestinationSpec,
  expectedStartSeg: string,
): string {
  const vol = dbVolumeName(newDb);
  const dataDir = ENGINES.POSTGRES.dataDir;
  const fetch = decodeChain(dest, storedObjectSourceCmd(dest, baseNs(srcId), base.filename), { gzip: true });
  const inner = [
    "set -e",
    `tar -xf - -C ${dataDir}`,
    `[ -s ${dataDir}/backup_label ] || { echo "tugra: base tar has no backup_label" >&2; exit 21; }`,
    `PGV=$(cat ${dataDir}/PG_VERSION | cut -d. -f1)`,
    // The cluster must match the server binary that will RUN it — the IMAGE's major (a custom image's row
    // `version` is not authoritative) — and be PG12+ (recovery.signal / -c recovery_* GUCs).
    `IMGV=$(postgres -V | cut -d" " -f3 | cut -d. -f1)`,
    `[ "$PGV" = "$IMGV" ] || { echo "tugra: base is Postgres $PGV but the image runs $IMGV" >&2; exit 21; }`,
    `[ "$PGV" -ge 12 ] 2>/dev/null || { echo "tugra: point-in-time restore needs Postgres 12 or newer (base is $PGV)" >&2; exit 25; }`,
    `grep -m1 '^START WAL LOCATION' ${dataDir}/backup_label | grep -q ${shq(`(file ${expectedStartSeg})`)} || { echo "tugra: backup_label start segment differs from the recorded start LSN" >&2; exit 23; }`,
    `touch ${dataDir}/recovery.signal`,
    `chown -R postgres:postgres ${dataDir}`,
    `chmod 700 ${dataDir}`,
    `echo "TUGRA_PITR_SEED ok pgver=$PGV start=${expectedStartSeg}"`,
  ].join("; ");
  const lines: string[] = ["set -e", "set -o pipefail"];
  if (dest.type === "S3" && dest.s3) lines.push(MC_INSTALL);
  lines.push(
    `VOL=${shq(vol)}`,
    `IMG=${shq(newDb.image)}`,
    `docker pull "$IMG" >/dev/null 2>&1 || { echo "tugra: could not pull ${newDb.image}" >&2; exit 13; }`,
    `docker volume create "$VOL" >/dev/null`,
    `[ -z "$(docker run --rm -v "$VOL":/d --entrypoint sh "$IMG" -c 'ls -A /d')" ] || { echo "tugra: target volume is not empty" >&2; exit 20; }`,
    `${fetch} | docker run --rm -i --user 0 --entrypoint sh -v "$VOL":${dataDir} "$IMG" -c ${shq(inner)}`,
  );
  return lines.join("\n");
}

export function parsePitrSeed(output: string): { pgver: string; start: string } | null {
  const m = /^TUGRA_PITR_SEED ok pgver=(\S+) start=(\S+)$/m.exec(output);
  return m ? { pgver: m[1], start: m[2] } : null;
}

// ── waiting for recovery to finish ──

function psqlFn(container: string, creds: DbCredentials): string {
  const { username, password, database } = creds;
  return `P() { docker exec -e PGPASSWORD=${shq(password)} ${container} psql -U ${shq(username)} -d ${shq(database)} -tAc "$1"; }`;
}

/**
 * WAIT for the recovering container to PROMOTE. Readiness (`SELECT 1`) is NOT proof: hot_standby lets psql
 * connect while WAL is still replaying, so the signal is pg_is_in_recovery() = false. A container that exits or
 * crash-loops (PG13+ FATALs when the target is past the end of the staged WAL) is exit 31 with the log tail;
 * `budgetSec` without promotion is exit 32 (the hub may call again — "still replaying", not failure). After
 * promotion the log must show Postgres STOPPING AT the target (exit 33 otherwise): PG12 silently promotes at
 * end-of-WAL when the target lies beyond it, which would hand back a copy from the wrong moment.
 */
export function buildPitrRecoveryWaitScript(db: DbSpec, budgetSec: number): string {
  const c = dbContainerName(db);
  const budget = Math.max(10, Math.floor(budgetSec));
  return [
    "set -e",
    psqlFn(c, db.credentials),
    `i=0; while [ $i -lt ${budget} ]; do`,
    `  S=$(docker inspect -f '{{.State.Running}} {{.State.Restarting}} {{.RestartCount}}' ${c} 2>/dev/null || echo "false false 0")`,
    `  case "$S" in "true false 0") ;; *)`,
    // PG13+ refuses a target that lies beyond the staged WAL ("recovery ended before configured recovery target was
    // reached") and exits → a crash loop under --restart. Report that as the same "target not reachable" (33) the
    // PG12 silent-promote path yields, so the user gets one actionable hint: pick an earlier time.
    `    if docker logs ${c} 2>&1 | grep -q 'recovery ended before configured recovery target'; then echo "tugra: the staged WAL ends before the target time" >&2; exit 33; fi`,
    `    echo "tugra: postgres exited during recovery ($S)" >&2; docker logs --tail 40 ${c} 2>&1 | tail -n 40; exit 31;; esac`,
    `  R=$(P "select pg_is_in_recovery()" 2>/dev/null || true)`,
    `  if [ "$R" = f ]; then`,
    `    docker logs ${c} 2>&1 | grep -Eq 'recovery stopping (before|after|at)' || { echo "tugra: recovery ended without reaching the target time (the staged WAL ends before it)" >&2; exit 33; }`,
    // Capture BEFORE printing (an empty capture must not become a bogus success line). Timeline from the current
    // WAL file name: pg_control_checkpoint() lags until the post-promote checkpoint completes.
    `    L=$(P 'select pg_current_wal_lsn()' 2>/dev/null || true); TL=$(P 'select substr(pg_walfile_name(pg_current_wal_lsn()),1,8)' 2>/dev/null || true)`,
    `    if [ -n "$L" ] && [ -n "$TL" ]; then echo "TUGRA_PITR_RESTORE ok lsn=$L tl=$TL"; exit 0; fi`,
    `  fi`,
    `  i=$((i+2)); sleep 2`,
    `done`,
    `echo "tugra: recovery still running after ${budget}s" >&2; exit 32`,
  ].join("\n");
}

export function parsePitrRestore(output: string): { lsn: string; timeline: number } | null {
  const m = /^TUGRA_PITR_RESTORE ok lsn=(\S+) tl=([0-9A-Fa-f]{1,8})$/m.exec(output);
  return m ? { lsn: m[1], timeline: parseInt(m[2], 16) } : null;
}

/** Remove a replay target's host staging dir (idempotent). Called after a successful promote (the segments are
 *  consumed) and by the failure reap. */
export function buildWalRestoreCleanScript(newId: string): string {
  return `rm -rf ${shq(walRestoreHostDir(newId))} 2>/dev/null || true`;
}

/** Actionable text for a prepare/seed/stage/wait exit code. */
export function pitrRestoreExitHint(exitCode: number | null, phase: "prepare" | "seed" | "stage" | "wait"): string {
  const table: Record<string, Record<number, string>> = {
    prepare: {
      13: "The database image could not be pulled from its registry.",
      21: "The database image has no 'postgres' user.",
      22: "This image keeps its data directory somewhere else (Postgres 18+); point-in-time restore does not support it yet.",
      24: "Not enough free disk under /etc/tugra to stage the WAL for this restore.",
    },
    seed: {
      13: "The database image could not be pulled from its registry.",
      20: "The target data volume already holds data.",
      21: "The base backup is not a usable Postgres cluster for the image that will run it.",
      23: "The base backup's start segment does not match its recorded start LSN (non-default WAL segment size?).",
      25: "Point-in-time restore needs Postgres 12 or newer.",
    },
    stage: { 1: "A WAL segment could not be downloaded from the backup destination." },
    wait: {
      31: "Postgres exited during recovery — the staged WAL could not be replayed (see the log tail).",
      32: "Recovery is still running.",
      33: "No committed change exists after the target time in the archived WAL (the window's end is an upper bound); choose an earlier time.",
    },
  };
  return table[phase]?.[exitCode ?? -1] ?? `PITR ${phase} failed (exit ${exitCode ?? "?"}).`;
}
