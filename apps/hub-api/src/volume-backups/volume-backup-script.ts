/**
 * Pure builders for the shell scripts the agent runs to back up / restore a
 * Docker named volume to/from a backup destination (local disk or S3). Mirrors
 * backups/backup-script.ts but the payload is a tar of the volume instead of a
 * DB dump: `docker run --rm -v <vol>:/data alpine tar` streams to gzip → [gpg]
 * → sink, never through the 64KB exec channel.
 */
import { mcHostEnv, mcTarget, MC_INSTALL, type DestinationSpec } from "../backups/destination";
// Shared mc-output parser (also used by DB backups) — re-exported so existing importers keep working.
export { parseShareUrl } from "../backups/destination";

export const VOL_BACKUP_DIR = "/etc/tugra/volume-backups";

// The tar/restore helper container. Pinned to the multi-arch manifest-list (index) @sha256 digest for
// supply-chain integrity (was a bare `alpine`, i.e. implicit :latest) — see HEALTH_PROBE_IMAGE in
// deploy-script.ts for the bump procedure. Only runs `tar`/`sh`, so the exact minor version is immaterial.
export const BACKUP_HELPER_IMAGE =
  "alpine:3.21@sha256:48b0309ca019d89d40f670aa1bc06e426dc0931948452e8491e3d65087abc07d";

function shq(v: string): string {
  return `'${v.replaceAll("'", "'\\''")}'`;
}

/** id namespace inside the bucket/dir: <appId>/<volumeName>. */
function ns(appId: string, volumeName: string): string {
  return `${appId}/${volumeName}`;
}

export function volumeBackupFilename(ts: string, dest: DestinationSpec): string {
  let f = `${ts}.tar.gz`;
  if (dest.encryption.enabled) f += ".gpg";
  return f;
}

export function volumeBackupDir(appId: string, volumeName: string): string {
  return `${VOL_BACKUP_DIR}/${appId}/${volumeName}`;
}

export function volumeBackupPath(appId: string, volumeName: string, filename: string): string {
  return `${volumeBackupDir(appId, volumeName)}/${filename}`;
}

function gpgEncrypt(dest: DestinationSpec): string {
  return `gpg --batch --yes --passphrase ${shq(dest.encryption.key)} --symmetric --cipher-algo AES256`;
}

function gpgDecrypt(dest: DestinationSpec): string {
  return `gpg --batch --yes --passphrase ${shq(dest.encryption.key)} --decrypt`;
}

export function buildVolumeBackupScript(
  appId: string,
  volumeName: string,
  dockerVolume: string,
  filename: string,
  dest: DestinationSpec,
): string {
  const lines = ["set -e", "set -o pipefail"];
  const pipe = [`docker run --rm -v ${shq(dockerVolume)}:/data:ro ${BACKUP_HELPER_IMAGE} tar -C /data -cf - .`, "gzip"];
  if (dest.encryption.enabled) pipe.push(gpgEncrypt(dest));

  if (dest.type === "S3" && dest.s3) {
    lines.push(MC_INSTALL);
    const target = mcTarget(dest.s3, ns(appId, volumeName), filename);
    // bash -o pipefail so a failed tar/dump stage fails the whole command (plain `sh -c` would let
    // `mc pipe` exit 0 after uploading a truncated object → backup wrongly recorded SUCCESS).
    lines.push(`${mcHostEnv(dest.s3)} bash -o pipefail -c ${shq(`${pipe.join(" | ")} | mc pipe ${target}`)}`);
    lines.push(`${mcHostEnv(dest.s3)} mc stat --json ${target}`);
  } else {
    const dir = volumeBackupDir(appId, volumeName);
    const file = volumeBackupPath(appId, volumeName, filename);
    lines.push(`mkdir -p ${dir}`);
    lines.push(`${pipe.join(" | ")} > ${file}`);
    lines.push(`stat -c %s ${file}`);
  }
  return lines.join("\n");
}

/**
 * The validated, rollback-protected wipe+extract shared by restore and import. The decoded archive is
 * already staged at $TMP. Steps:
 *  1. VALIDATE the tar layer BEFORE touching the volume — a valid gzip wrapping a corrupt/truncated tar
 *     would otherwise wipe the volume and only then fail (`tar -tf` lists without extracting, in a helper
 *     with NO volume mounted, so a bad archive aborts here under `set -e` with the live data intact).
 *  2. Reject absolute paths and `..` traversal entries (defence in depth, even for our own backup).
 *  3. SNAPSHOT the live volume to a rollback volume, so a failed/interrupted extract can be rolled back and
 *     the old data is preserved. If the disk is too full to snapshot, `set -e` aborts HERE (before the
 *     wipe) → the live data stays intact.
 *  4. Wipe + extract the validated archive. On failure, restore from the snapshot; if that also fails,
 *     leave BOTH volumes and signal recovery.
 * Exit/marker contract the hub reads: exit 0 + `TUGRA_RESTORE_OK` = success; exit 1 = failed, old data
 * restored; exit 2 + `TUGRA_RESTORE_RECOVERY_REQUIRED` = failed, manual recovery required. This is NOT
 * atomic — Docker has no atomic volume swap; a hard kill mid-extract is recoverable from the snapshot, not
 * seamless. `tarFlags` is "" for our own backup (keep ownership) or "--no-same-owner " for an untrusted import.
 */
function safeWipeExtract(dockerVolume: string, restoreId: string, tarFlags: string): string[] {
  const img = BACKUP_HELPER_IMAGE;
  const rb = `tugra_restore_rb_${restoreId}`;
  const vol = shq(dockerVolume);
  const rbq = shq(rb);
  // Exit-code contract the hub reads (robust to the agent's output cap — the hub keys off the code, not an
  // end-of-output marker): 0 = success; 72 = aborted BEFORE the wipe (live data intact); 71 = extract
  // failed, rolled back from the snapshot (live data intact); 70 = extract AND rollback failed, snapshot
  // kept for manual recovery. A SIGKILL (timeout/cancel, exit -1/137) skips all of this → the hub treats
  // any other code as an unknown outcome (possibly mid-restore; the snapshot volume survives for recovery).
  return [
    // 1. VALIDATE the tar layer before touching the volume. Corrupt/truncated → exit 72, data intact.
    `docker run --rm -i ${img} tar -tf - < "$TMP" > "$TMP.list" 2>/dev/null || { echo "invalid archive" >&2; exit 72; }`,
    // 2. An all-zero / empty tar lists nothing and `tar -tf` exits 0 — reject it so it can't wipe to empty.
    //    Our own backups always carry a `./` entry.
    `[ -s "$TMP.list" ] || { echo "empty archive" >&2; exit 72; }`,
    // 3. Reject absolute / `..` entries (LC_ALL=C so an invalid-UTF-8 byte can't dodge the match).
    `if LC_ALL=C grep -Eq '^/|(^|/)[.][.](/|$)' "$TMP.list"; then echo "unsafe archive entry" >&2; exit 72; fi`,
    // 4. SNAPSHOT the live volume (labelled for discovery/cleanup) so a failed/interrupted extract rolls
    //    back. A snapshot failure (e.g. disk full) → exit 72 with data intact; clean up any partial snapshot.
    `docker volume create --label tugra.restore-rb=${shq(restoreId)} ${rbq} >/dev/null || { echo "snapshot volume create failed" >&2; exit 72; }`,
    `docker run --rm -v ${vol}:/src:ro -v ${rbq}:/dst ${img} sh -c 'cp -a /src/. /dst/' || { docker volume rm ${rbq} >/dev/null 2>&1 || true; echo "snapshot failed" >&2; exit 72; }`,
    // 5. Extract the validated archive into the live volume; on failure restore from the snapshot.
    `if docker run --rm -i -v ${vol}:/data ${img} sh -c 'cd /data && find . -mindepth 1 -delete; tar ${tarFlags}-xf -' < "$TMP"; then`,
    `  docker volume rm ${rbq} >/dev/null 2>&1 || true`,
    `  echo TUGRA_RESTORE_OK`,
    `elif docker run --rm -v ${rbq}:/src:ro -v ${vol}:/data ${img} sh -c 'cd /data && find . -mindepth 1 -delete; cp -a /src/. /data/'; then`,
    `  docker volume rm ${rbq} >/dev/null 2>&1 || true`,
    `  echo TUGRA_RESTORE_FAILED_ROLLED_BACK >&2; exit 71`,
    `else`,
    `  echo "TUGRA_RESTORE_RECOVERY_REQUIRED rollback=${rb}" >&2; exit 70`,
    `fi`,
  ];
}

export function buildVolumeRestoreScript(
  appId: string,
  volumeName: string,
  dockerVolume: string,
  filename: string,
  dest: DestinationSpec,
  restoreId: string,
): string {
  let source: string;
  if (dest.type === "S3" && dest.s3) {
    source = `${mcHostEnv(dest.s3)} mc cat ${mcTarget(dest.s3, ns(appId, volumeName), filename)}`;
  } else {
    source = `cat ${volumeBackupPath(appId, volumeName, filename)}`;
  }
  const decode = [source];
  if (dest.encryption.enabled) decode.push(gpgDecrypt(dest));
  decode.push("gunzip");

  // Stage the decoded archive to a temp file FIRST. With `set -e` + `set -o pipefail`, a failed/expired
  // source (S3 fetch, wrong decryption key, gzip mismatch, truncated stream) aborts HERE — before the
  // volume is touched. The validated, rollback-protected wipe+extract follows (see safeWipeExtract); this
  // restores OUR OWN backup → ownership is preserved (tarFlags "").
  return [
    "set -e",
    "set -o pipefail",
    "TMP=$(mktemp)",
    `trap 'rm -f "$TMP" "$TMP.list"' EXIT`,
    `${decode.join(" | ")} > "$TMP"`,
    ...safeWipeExtract(dockerVolume, restoreId, ""),
  ].join("\n");
}

/**
 * Import an app volume's data from an external tar(.gz) URL (migrator data-pull).
 * Mirrors buildImportScript (DB) + buildVolumeRestoreScript's clean extract: fetch
 * the staged tar → [gpg -d] → [gunzip] → wipe the volume then extract into it.
 */
export function buildVolumeImportScript(
  dockerVolume: string,
  url: string,
  restoreId: string,
  opts: { encrypted: boolean; key: string; gzip: boolean; maxDecodedBytes?: number },
): string {
  const dest: DestinationSpec = { type: "LOCAL", encryption: { enabled: opts.encrypted, key: opts.key } };
  const decode = [`curl -fsSL ${shq(url)}`];
  if (opts.encrypted) decode.push(gpgDecrypt(dest));
  if (opts.gzip) decode.push("gunzip");
  // Bound the DECODED size when the tarball is UNTRUSTED (migration ingest passes maxDecodedBytes): a gzip
  // bomb (~1000:1) would otherwise decompress to hundreds of GiB and fill the target host's disk during the
  // restore. `head -c (cap+1)` stops reading past the cap — gunzip then dies on SIGPIPE, which trips pipefail
  // and aborts BEFORE the wipe; the explicit size check below also catches the exact-boundary case. Unset
  // (the user-driven import-from-url path) keeps the original unbounded behavior.
  const cap = opts.maxDecodedBytes && opts.maxDecodedBytes > 0 ? Math.floor(opts.maxDecodedBytes) : 0;
  if (cap) decode.push(`head -c ${cap + 1}`);
  // Download + decode to a TEMP FILE FIRST. With `set -e` + `set -o pipefail`, a failed/expired URL, wrong
  // key, or gzip-flag mismatch aborts HERE — before the volume is touched. Then the validated,
  // rollback-protected wipe+extract (safeWipeExtract) also validates the tar layer and snapshots the live
  // volume, so a corrupt tar or an interrupted extract never destroys existing data. --no-same-owner: an
  // UNTRUSTED external tar must not restore arbitrary uid/gid.
  const lines = [
    "set -e",
    "set -o pipefail",
    "TMP=$(mktemp)",
    `trap 'rm -f "$TMP" "$TMP.list"' EXIT`,
    `${decode.join(" | ")} > "$TMP"`,
  ];
  if (cap) lines.push(`if [ "$(wc -c < "$TMP")" -gt ${cap} ]; then echo "decoded volume exceeds the ${cap}-byte cap" >&2; exit 1; fi`);
  lines.push(...safeWipeExtract(dockerVolume, restoreId, "--no-same-owner "));
  return lines.join("\n");
}

export function buildVolumeDeleteScript(
  appId: string,
  volumeName: string,
  filename: string,
  dest: DestinationSpec,
): string {
  if (dest.type === "S3" && dest.s3) {
    return `${mcHostEnv(dest.s3)} mc rm ${mcTarget(dest.s3, ns(appId, volumeName), filename)} 2>/dev/null || true`;
  }
  return `rm -f ${volumeBackupPath(appId, volumeName, filename)} 2>/dev/null || true`;
}

/**
 * Produce a presigned download URL for an existing S3 volume backup so it can be pulled by the
 * import-from-URL flow on another server (migration). `expire` is an mc duration string like "24h".
 * S3-only — the caller guards `dest.type === "S3"` first (a LOCAL backup has no presignable object).
 */
export function buildVolumeExportUrlScript(
  appId: string,
  volumeName: string,
  filename: string,
  dest: DestinationSpec,
  expire: string,
): string {
  if (dest.type !== "S3" || !dest.s3) throw new Error("export URL requires an S3 destination");
  const target = mcTarget(dest.s3, ns(appId, volumeName), filename);
  return [MC_INSTALL, `${mcHostEnv(dest.s3)} mc share download --expire ${shq(expire)} --json ${shq(target)}`].join("\n");
}

