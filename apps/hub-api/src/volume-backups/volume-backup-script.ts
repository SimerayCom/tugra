/**
 * Pure builders for the shell scripts the agent runs to back up / restore a
 * Docker named volume to/from a backup destination (local disk or S3). Mirrors
 * backups/backup-script.ts but the payload is a tar of the volume instead of a
 * DB dump: `docker run --rm -v <vol>:/data alpine tar` streams to gzip → [gpg]
 * → sink, never through the 64KB exec channel.
 */
import { mcHostEnv, mcTarget, type DestinationSpec } from "../backups/destination";

export const VOL_BACKUP_DIR = "/etc/tugra/volume-backups";

function shq(v: string): string {
  return `'${v.replaceAll("'", "'\\''")}'`;
}

const MC_INSTALL =
  "command -v mc >/dev/null 2>&1 || { curl -sSL https://dl.min.io/client/mc/release/linux-amd64/mc -o /usr/local/bin/mc && chmod +x /usr/local/bin/mc; }";

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
  const pipe = [`docker run --rm -v ${shq(dockerVolume)}:/data:ro alpine tar -C /data -cf - .`, "gzip"];
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
  const extract = `docker run --rm -i -v ${shq(dockerVolume)}:/data alpine sh -c ${shq("cd /data && find . -mindepth 1 -delete 2>/dev/null; tar -xf -")}`;
  return ["set -e", "set -o pipefail", `${decode.join(" | ")} | ${extract}`].join("\n");
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
