/**
 * Pure builders for the WAL shipper (PITR 5.5). A PITR-enabled Postgres container's archive_command copies
 * each completed WAL segment into a per-DB host spool (/etc/tugra/wal/<id>, see database-script.ts). This
 * shipper drains that spool to the configured backup destination so the local spool stays BOUNDED: a segment
 * is uploaded, its object is proven to exist, and only THEN is the spool copy deleted. Un-shipped WAL is never
 * dropped (that would break the recovery chain). Objects use the segment's own name as the stem under a
 * `<dbId>/wal/` namespace, a sibling of the base-backup namespace, so a future PITR replay (5.6) can map a
 * restore_command `%f` straight to an object with no extra state.
 *
 * Everything here runs over the existing opaque "backup" agent capability — no Go-agent change.
 */

import { type DestinationSpec } from "./destination";
import { buildDumpUploadScript } from "./backup-script";
import { walHostDir } from "../databases/database-script";

/** Storage namespace for a database's shipped WAL — sibling of baseNs(`<id>/base`). */
export function walNs(dbId: string): string {
  return `${dbId}/wal`;
}

/** The destination object name for a WAL segment: its own name + the pipeline suffixes (.gz always, .gpg when
 *  the destination is encrypted). DETERMINISTIC (no timestamp) so a re-ship after a crash overwrites the same
 *  key instead of duplicating the segment. */
export function walObjectName(seg: string, dest: DestinationSpec): string {
  return dest.encryption.enabled ? `${seg}.gz.gpg` : `${seg}.gz`;
}

// Strict allow-list for a shippable spool entry. Postgres writes three kinds of file into pg_wal/the spool:
//   - a 24-hex WAL segment (8-hex timeline + 16-hex log/seg), e.g. 000000010000000000000003
//   - a timeline history file,  e.g. 00000002.history
//   - a backup label file,      e.g. 000000010000000000000003.00000028.backup
// Everything else — a *.part temp (an in-flight archive_command copy), a dotfile, anything with a shell
// metacharacter or path traversal — is NEVER shipped. The names come from a directory the Postgres container
// writes and are spliced into a root shell on the agent, so they are validated BOTH on the agent (the list
// command) and here on the hub before the ship command is built.
const WAL_SEGMENT = /^[0-9A-F]{24}$/;
const WAL_HISTORY = /^[0-9A-F]{8}\.history$/;
const WAL_BACKUP_LABEL = /^[0-9A-F]{24}\.[0-9A-F]{8}\.backup$/;

export function isShippableWalName(name: string): boolean {
  return WAL_SEGMENT.test(name) || WAL_HISTORY.test(name) || WAL_BACKUP_LABEL.test(name);
}

/** Single-quote a value for safe interpolation into an `sh -c` command string. */
function shq(v: string): string {
  return `'${v.replaceAll("'", "'\\''")}'`;
}

/** Max spool entries enumerated with a size in one list (the true backlog COUNT is still reported in full). */
const WAL_LIST_SIZE_CAP = 500;

/**
 * List the spool: print `WAL <name> <size>` for each regular, non-`.part` file in WAL order (lexicographic =
 * timeline/segment order), and a trailing `TUGRA_WAL_LIST total=<N>` with the full backlog count. Read-only.
 * A missing spool dir (PITR never armed / already drained) reports total=0 and exits 0.
 */
export function buildWalListScript(dbId: string): string {
  const dir = walHostDir(dbId);
  return [
    `dir=${shq(dir)}`,
    `[ -d "$dir" ] || { echo "TUGRA_WAL_LIST total=0"; exit 0; }`,
    `cd "$dir" || { echo "TUGRA_WAL_LIST total=0"; exit 0; }`,
    `n=0`,
    // Enumerate with a glob, NOT `$(ls)`: an unquoted command substitution would word-split and re-glob a
    // tenant-planted filename (a file literally named `*`, or one with a space), so a crafted name could inject
    // or duplicate a real segment. A glob yields each real filename as one word (leading-dot files are excluded
    // by `*`), and we reject anything that is not a plain regular file — in particular a SYMLINK, which a DB
    // superuser could point at a host secret (COPY ... TO PROGRAM can write into the spool) to have the root
    // agent shell cat and upload it. A coarse char allow-list (alphanumerics + dot) blocks every shell
    // metacharacter / path separator here; the hub then applies the exact WAL-name shapes (isShippableWalName).
    `for f in *; do`,
    `  [ -e "$f" ] || continue`,
    `  [ -f "$f" ] && [ ! -L "$f" ] || continue`,
    `  case "$f" in *.part) continue;; esac`,
    `  case "$f" in *[!0-9A-Za-z.]*) continue;; esac`,
    `  n=$((n+1))`,
    `  if [ "$n" -le ${WAL_LIST_SIZE_CAP} ]; then`,
    `    sz=$(stat -c %s "$f" 2>/dev/null || wc -c < "$f" 2>/dev/null || echo 0)`,
    `    echo "WAL $f $sz"`,
    `  fi`,
    `done`,
    `echo "TUGRA_WAL_LIST total=$n"`,
  ].join("\n");
}

/**
 * Ship the given segments IN ORDER, each through the shared upload sink (gzip → [gpg] → mc pipe / atomic LOCAL
 * write). For each segment: on a clean upload echo `TUGRA_WAL_OK <name>` and delete the spool copy; on the
 * FIRST failure echo `TUGRA_WAL_FAIL <name>` and stop (so the destination always holds a contiguous prefix of
 * the chain and the failed segment is retried next tick). The spool file is deleted ONLY after the upload
 * pipeline exited 0 — un-shipped WAL is never dropped. `names` must already be allow-list-validated by the
 * caller. Each upload's own stdout (size line) is discarded; its stderr flows through so a failure's cause is
 * captured for the alert.
 */
export function buildWalShipScript(dbId: string, names: string[], dest: DestinationSpec): string {
  const spoolDir = walHostDir(dbId);
  const blocks = names.map((name) => {
    const spoolPath = `${spoolDir}/${name}`;
    const upload = buildDumpUploadScript(`cat ${shq(spoolPath)}`, walNs(dbId), walObjectName(name, dest), dest, null, {
      atomicLocal: true,
    });
    return [
      // Re-check at ship time that the entry is still a plain regular file, not a symlink swapped in since the
      // list ran (TOCTOU) — never cat/upload through a symlink.
      `if [ ! -f ${shq(spoolPath)} ] || [ -L ${shq(spoolPath)} ]; then echo "TUGRA_WAL_FAIL ${name}"; exit 1; fi`,
      // Run the upload as a STANDALONE subshell (NOT an `if`-condition): errexit/pipefail are ignored inside an
      // if-condition compound even when the subshell re-sets them, which would let a failed pipeline fall
      // through to a success exit on the trailing `stat`/`mc stat` and wrongly delete the un-shipped segment.
      // As a standalone command the subshell's own `set -e` aborts on the first failed stage; we then branch on
      // its real exit code. The spool copy is deleted ONLY on a clean (exit 0) upload; the first failure stops
      // the batch so the destination always holds a contiguous shipped prefix.
      `(`,
      upload,
      `) >/dev/null`,
      `rc=$?`,
      `if [ "$rc" -eq 0 ]; then`,
      `  echo "TUGRA_WAL_OK ${name}"`,
      `  rm -f ${shq(spoolPath)}`,
      `else`,
      `  echo "TUGRA_WAL_FAIL ${name}"`,
      `  exit 1`,
      `fi`,
    ].join("\n");
  });
  return blocks.join("\n");
}

export interface WalListEntry {
  name: string;
  size: bigint;
}

/** Parse buildWalListScript output into the enumerated entries (first WAL_LIST_SIZE_CAP) and the full backlog
 *  count. `total` is NULL when the summary marker is absent (the list command died or its output was truncated):
 *  an unknown backlog must never be read as "empty" — the disable path purges the spool on backlog 0. */
export function parseWalList(output: string): { entries: WalListEntry[]; total: number | null } {
  const entries: WalListEntry[] = [];
  let total: number | null = null;
  for (const line of output.split("\n")) {
    const wal = line.match(/^WAL (\S+) (\d+)$/);
    if (wal) {
      entries.push({ name: wal[1], size: BigInt(wal[2]) });
      continue;
    }
    const sum = line.match(/^TUGRA_WAL_LIST total=(\d+)$/);
    if (sum) total = Number(sum[1]);
  }
  return { entries, total };
}

/** Parse buildWalShipScript output into the segments that shipped (deleted from the spool) and the one that
 *  failed (stop-at-first-failure, so at most one). */
export function parseWalShipped(output: string): { shipped: string[]; failed: string[] } {
  const shipped: string[] = [];
  const failed: string[] = [];
  for (const line of output.split("\n")) {
    const ok = line.match(/^TUGRA_WAL_OK (\S+)$/);
    if (ok) shipped.push(ok[1]);
    const bad = line.match(/^TUGRA_WAL_FAIL (\S+)$/);
    if (bad) failed.push(bad[1]);
  }
  return { shipped, failed };
}
