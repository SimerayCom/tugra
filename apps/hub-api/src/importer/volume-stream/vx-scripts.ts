/**
 * Pure builders + strict parsers for the shell the TARGET agent runs when a streamed migration volume is applied.
 * Everything is a plain function of its inputs (golden-string tested): no I/O, no DI. Every value is validated BEFORE it
 * is interpolated and `shq()`-quoted on top, so nothing a migrator or a user typed can reach a shell unquoted. The parts
 * themselves arrive through the existing app-move receive script (`buildMoveRecvScript`), unchanged.
 */
import { BACKUP_HELPER_IMAGE, safeWipeExtract } from "../../volume-backups/volume-backup-script";
import { MOVE_STAGING_ROOT, assertDockerName, assertMoveId, assertPart, partName, shq } from "../../app-moves/app-move-scripts";
import { VX_VOL_IDX } from "./vx-constants";

const IMG = BACKUP_HELPER_IMAGE;

/** Exit codes the apply script adds to the restore contract (0 ok / 72 aborted before the wipe / 71 rolled back / 70 recovery required). */
export const MIGRATION_EXIT = {
  noParts: 67, // no staged parts on the target
  entryMismatch: 68, // extracted entry count differs from the source's
  pgVersion: 69, // PG_VERSION of the extracted cluster is not the expected major
} as const;

/** A hub-constant tar exclude (`postmaster.pid`): never user text. */
const EXCLUDE_RE = /^[A-Za-z0-9._-]{1,64}$/;
const RESTORE_ID_RE = /^[A-Za-z0-9_]{1,80}$/;

function rootOf(transferId: string): string {
  return `${MOVE_STAGING_ROOT}/${assertMoveId(transferId)}`;
}

function assertPosInt(n: number, what: string): number {
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`invalid ${what}: ${n}`);
  return n;
}
function assertNatInt(n: number, what: string): number {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`invalid ${what}: ${n}`);
  return n;
}

export interface MigrationApplyInput {
  transferId: string;
  dockerVolume: string;
  /** Rollback-snapshot id (`vx<transferId><attempt>`), new per attempt. */
  restoreId: string;
  expectedEntries: number;
  /** Decoded (tar) size: the decoded stream is cut to this many bytes (a gzip bomb cannot exceed it). */
  rawBytes: number;
  /** Tar excludes the SOURCE applied (the entry count must be taken the same way). Hub constants only. */
  excludes: string[];
  /** db-data only: the PostgreSQL major the extracted cluster must report in PG_VERSION. */
  expectPgMajor?: string;
}

/**
 * (target) Verify-then-wipe-then-extract the staged gzip parts into the destination volume, rollback-protected exactly
 * like a volume restore, streaming `cat p.* | gunzip | head -c <rawBytes>` into docker TWICE (validate, extract) so no
 * decoded tar ever sits on disk. Ownership is PRESERVED (no --no-same-owner). `drain` makes the consumers read to EOF so
 * a valid archive is never reported invalid because `head` closed the pipe first. Afterwards the entry count must equal
 * the source's (68) and, for a Postgres cluster, PG_VERSION must be the expected major (69). The `applied` marker is
 * written BEFORE the parts are removed, so a crash in between is recoverable (never a half-applied guess).
 * Prints `TUGRA_VX_APPLY_OK entries=<e>`.
 */
export function buildMigrationApplyScript(i: MigrationApplyInput): string {
  const root = rootOf(i.transferId);
  const vol = shq(assertDockerName(i.dockerVolume));
  if (typeof i.restoreId !== "string" || !RESTORE_ID_RE.test(i.restoreId)) throw new Error("invalid restore id");
  assertNatInt(i.expectedEntries, "expected entries");
  assertPosInt(i.rawBytes, "raw bytes");
  for (const e of i.excludes) if (!EXCLUDE_RE.test(e)) throw new Error(`invalid exclude: ${JSON.stringify(e)}`);
  if (i.expectPgMajor !== undefined && !/^[0-9]{1,2}$/.test(i.expectPgMajor)) throw new Error("invalid PostgreSQL major");
  const findExcl = i.excludes.map((e) => ` ! -path /data/${e}`).join("");
  const lines = [
    "set -e",
    "set -o pipefail",
    `ROOT=${root}`,
    `DIR="$ROOT/${VX_VOL_IDX}"`,
    '[ -d "$DIR" ] || { echo "no staged parts" >&2; exit 67; }',
    'echo $$ > "$ROOT/applying.lock"',
    "TMP=$(mktemp)",
    `trap 'rm -f "$TMP" "$TMP.list" "$ROOT/applying.lock"' EXIT`,
    // glob order is lexical = part order (5-digit suffixes); head -c bounds the DECODED size (gzip-bomb safe)
    `vx_stream() { cat "$DIR"/p.* | gunzip | head -c ${i.rawBytes}; }`,
    ...safeWipeExtract(i.dockerVolume, i.restoreId, "", { kind: "stream", fn: "vx_stream", drain: true }),
    `E=$(docker run --rm -v ${vol}:/data:ro ${IMG} sh -c 'find /data -mindepth 1 ! -type s${findExcl} | wc -l | tr -d " "')`,
    `[ "$E" = "${i.expectedEntries}" ] || { echo "entry count mismatch" >&2; exit ${MIGRATION_EXIT.entryMismatch}; }`,
  ];
  if (i.expectPgMajor !== undefined) {
    lines.push(
      `V=$(docker run --rm -v ${vol}:/data:ro ${IMG} cat /data/PG_VERSION | tr -d ' \\r\\n')`,
      `[ "$V" = "${i.expectPgMajor}" ] || { echo "postgresql version mismatch" >&2; exit ${MIGRATION_EXIT.pgVersion}; }`,
    );
  }
  lines.push(': > "$ROOT/applied"', 'echo "TUGRA_VX_APPLY_OK entries=$E"', 'rm -rf "$DIR"');
  return lines.join("\n");
}

const APPLY_OK_RE = /^TUGRA_VX_APPLY_OK entries=(\d+)$/;

/** `TUGRA_VX_APPLY_OK entries=N` exactly once as a whole line; anything else (absent, duplicate, extra fields) is null. */
export function parseMigrationApplyOk(output: string): number | null {
  const hits = (output ?? "").split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.startsWith("TUGRA_VX_APPLY_OK"));
  if (hits.length !== 1) return null;
  const m = APPLY_OK_RE.exec(hits[0]);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * (target) Print `TUGRA_VX_STATE running=<0|1> applied=<0|1> parts=<n> rb=<0|1>` — what the hub needs to settle an apply
 * it lost track of (hub restart): `running` = the apply's lock file names a live process, `applied` = the marker exists,
 * `parts` = complete staged parts, `rb` = a rollback snapshot volume of THIS transfer exists. Read-only.
 */
export function buildMigrationStateProbeScript(transferId: string): string {
  const root = rootOf(transferId);
  return [
    "set +e",
    `ROOT=${root}`,
    'R=0; if [ -f "$ROOT/applying.lock" ] && kill -0 "$(cat "$ROOT/applying.lock" 2>/dev/null)" 2>/dev/null; then R=1; fi',
    'A=0; [ -f "$ROOT/applied" ] && A=1',
    `P=$(ls "$ROOT/${VX_VOL_IDX}" 2>/dev/null | grep -c '^p\\.[0-9]\\{5\\}$')`,
    `B=0; if [ -n "$(docker volume ls -q --filter 'name=tugra_restore_rb_vx${transferId}' 2>/dev/null)" ]; then B=1; fi`,
    'echo "TUGRA_VX_STATE running=$R applied=$A parts=$P rb=$B"',
  ].join("\n");
}

export interface MigrationStateProbe {
  running: boolean;
  applied: boolean;
  parts: number;
  rollbackVolume: boolean;
}

const STATE_RE = /^TUGRA_VX_STATE running=([01]) applied=([01]) parts=(\d{1,6}) rb=([01])$/;

/** Exactly one state line; zero, two or a malformed one is null (the caller fails closed: "target state unknown"). */
export function parseMigrationStateProbe(output: string): MigrationStateProbe | null {
  const hits = (output ?? "").split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.startsWith("TUGRA_VX_STATE"));
  if (hits.length !== 1) return null;
  const m = STATE_RE.exec(hits[0]);
  if (!m) return null;
  return { running: m[1] === "1", applied: m[2] === "1", parts: Number(m[3]), rollbackVolume: m[4] === "1" };
}

/**
 * (target) Empty the destination volume. Used ONLY before an apply and by reset: the destination is disposable by the
 * deploy/NEW gate, so an apply always snapshots an EMPTY volume (never a partial 29 GB one). With `transferId` it also
 * removes the rollback snapshots of THIS transfer's earlier crashed attempts (each only after its label proves it is
 * ours), so a new attempt can never alias a stale snapshot.
 */
export function buildMigrationWipeDestScript(dockerVolume: string, transferId?: string): string {
  const vol = shq(assertDockerName(dockerVolume));
  const lines = ["set -e", `docker run --rm -v ${vol}:/data ${IMG} sh -c 'cd /data && find . -mindepth 1 -delete'`];
  if (transferId !== undefined) {
    assertMoveId(transferId);
    lines.push(
      "set +e",
      `for v in $(docker volume ls -q --filter 'name=tugra_restore_rb_vx${transferId}' 2>/dev/null); do`,
      `  lb=$(docker volume inspect -f '{{index .Labels "tugra.restore-rb"}}' "$v" 2>/dev/null)`,
      `  case "$lb" in vx${transferId}*) docker volume rm "$v" >/dev/null 2>&1 ;; esac`,
      "done",
      "exit 0",
    );
  }
  return lines.join("\n");
}

/**
 * (target) Remove the staging directory of a transfer and its rollback snapshots (label-checked). Best-effort; prints
 * `TUGRA_VX_CLEANUP_DONE` last. Used by reset, abort, rollback and the post-apply tidy-up.
 */
export function buildMigrationCleanupScript(transferId: string): string {
  const root = rootOf(transferId);
  return [
    "set +e",
    `rm -rf ${root}`,
    `for v in $(docker volume ls -q --filter 'name=tugra_restore_rb_vx${transferId}' 2>/dev/null); do`,
    `  lb=$(docker volume inspect -f '{{index .Labels "tugra.restore-rb"}}' "$v" 2>/dev/null)`,
    `  case "$lb" in vx${transferId}*) docker volume rm "$v" >/dev/null 2>&1 ;; esac`,
    "done",
    "echo TUGRA_VX_CLEANUP_DONE",
  ].join("\n");
}

/** (target) `TUGRA_VX_PART <bytes> <sha256>` of ONE staged part (the move scripts' stat needs a `sums` file a stream never has). */
export function buildMigrationPartStatScript(transferId: string, part: number): string {
  const f = `${rootOf(transferId)}/${VX_VOL_IDX}/${partName(assertPart(part))}`;
  return [
    "set -e",
    `F=${f}`,
    '[ -f "$F" ] || { echo "part missing" >&2; exit 66; }',
    'S=$(stat -c %s "$F")',
    'H=$(sha256sum "$F" | cut -d" " -f1)',
    'echo "TUGRA_VX_PART $S $H"',
  ].join("\n");
}

/** The restore id of an apply attempt: `vx<transferId><attempt>` (matches `^[A-Za-z0-9_]{1,80}$`). */
export function migrationRestoreId(transferId: string, attempt: number): string {
  return `vx${assertMoveId(transferId)}${assertPosInt(attempt, "attempt")}`;
}
