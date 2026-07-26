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
    lines.push(`${mcHostEnv(dest.s3)} sh -c ${shq(`${pipe.join(" | ")} | mc pipe ${target}`)}`);
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

export function buildVolumeRestoreScript(
  appId: string,
  volumeName: string,
  dockerVolume: string,
  filename: string,
  dest: DestinationSpec,
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

  // Clear the volume then extract (clean restore, including dotfiles).
  const extract = `docker run --rm -i -v ${shq(dockerVolume)}:/data ${BACKUP_HELPER_IMAGE} sh -c ${shq("cd /data && find . -mindepth 1 -delete 2>/dev/null; tar -xf -")}`;
  return ["set -e", "set -o pipefail", `${decode.join(" | ")} | ${extract}`].join("\n");
}

/**
 * Import an app volume's data from an external tar(.gz) URL (migrator data-pull).
 * Mirrors buildImportScript (DB) + buildVolumeRestoreScript's clean extract: fetch
 * the staged tar → [gpg -d] → [gunzip] → wipe the volume then extract into it.
 */
export function buildVolumeImportScript(
  dockerVolume: string,
  url: string,
  opts: { encrypted: boolean; key: string; gzip: boolean },
): string {
  const dest: DestinationSpec = { type: "LOCAL", encryption: { enabled: opts.encrypted, key: opts.key } };
  const decode = [`curl -fsSL ${shq(url)}`];
  if (opts.encrypted) decode.push(gpgDecrypt(dest));
  if (opts.gzip) decode.push("gunzip");
  // Download + decode to a TEMP FILE FIRST. With `set -e` + `set -o pipefail`, a failed/expired URL,
  // wrong key, or gzip-flag mismatch aborts HERE — before the volume is touched — so a failed import
  // never destroys existing data. Only once a valid archive is staged do we wipe + extract (clean
  // import). --no-same-owner: an UNTRUSTED external tar must not restore arbitrary uid/gid; the extract
  // container is ephemeral (--rm) with only the target volume mounted at /data.
  const extract = `docker run --rm -i -v ${shq(dockerVolume)}:/data ${BACKUP_HELPER_IMAGE} sh -c ${shq(
    "cd /data && find . -mindepth 1 -delete 2>/dev/null; tar --no-same-owner -xf -",
  )} < "$TMP"`;
  return [
    "set -e",
    "set -o pipefail",
    "TMP=$(mktemp)",
    `trap 'rm -f "$TMP"' EXIT`,
    `${decode.join(" | ")} > "$TMP"`,
    extract,
  ].join("\n");
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

