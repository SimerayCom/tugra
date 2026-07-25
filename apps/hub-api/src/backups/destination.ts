/**
 * Backup destination model + helpers. A destination is where dumps are stored:
 * LOCAL (the server's own disk) or S3 (any S3-compatible: AWS, Cloudflare R2,
 * MinIO). Credentials live encrypted in the DB and are decrypted into a
 * DestinationSpec only at the moment a backup/restore command is built.
 */

export type DestType = "LOCAL" | "S3";

export interface S3Config {
  bucket: string;
  region: string;
  endpoint: string; // host or full URL of the S3 endpoint
  accessKey: string;
  secretKey: string;
  prefix: string; // optional path prefix inside the bucket
}

export interface EncryptionConfig {
  enabled: boolean;
  key: string; // passphrase for gpg symmetric AES-256
}

export interface DestinationSpec {
  type: DestType;
  s3?: S3Config;
  encryption: EncryptionConfig;
}

export const LOCAL_DEST: DestinationSpec = {
  type: "LOCAL",
  encryption: { enabled: false, key: "" },
};

/** Single-quote a value for safe interpolation into an `sh -c` command string. */
function shq(v: string): string {
  return `'${v.replaceAll("'", "'\\''")}'`;
}

/** mc alias used transiently inside a single command (creds via MC_HOST_ env). */
export const MC_ALIAS = "tdest";

/** Normalize an endpoint to a scheme + host URL mc/MC_HOST understands. */
export function endpointUrl(s3: S3Config): string {
  const ep = s3.endpoint.trim();
  if (/^https?:\/\//i.test(ep)) return ep.replace(/\/+$/, "");
  return `https://${ep.replace(/\/+$/, "")}`;
}

/** MC_HOST_<alias> env carrying creds, so nothing is written to mc's config dir. The whole value is
 *  shell-quoted — encodeURIComponent leaves ' ! ~ * ( ) raw, which would otherwise break/inject the
 *  command line when the creds contain one (this env prefix is spliced into an `sh -c` string). */
export function mcHostEnv(s3: S3Config): string {
  const url = new URL(endpointUrl(s3));
  url.username = encodeURIComponent(s3.accessKey);
  url.password = encodeURIComponent(s3.secretKey);
  return `MC_HOST_${MC_ALIAS}=${shq(url.toString())}`;
}

/** The object key (path) inside the bucket for a given db + filename. */
export function objectKey(s3: S3Config, dbId: string, filename: string): string {
  const prefix = (s3.prefix || "").replace(/^\/+|\/+$/g, "");
  return [prefix, dbId, filename].filter(Boolean).join("/");
}

/** Full mc target: alias/bucket/key. */
export function mcTarget(s3: S3Config, dbId: string, filename: string): string {
  return `${MC_ALIAS}/${s3.bucket}/${objectKey(s3, dbId, filename)}`;
}

/** Extract the presigned download URL (the `share` field) from `mc share download --json` output. */
export function parseShareUrl(output: string): string | null {
  for (const line of output.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const j = JSON.parse(t) as { share?: unknown };
      if (typeof j.share === "string" && /^https?:\/\//i.test(j.share)) return j.share;
    } catch {
      /* not a JSON line — keep scanning */
    }
  }
  return null;
}
