import { createHash } from "node:crypto";
import { verifyEd25519 } from "../servers/agent-auth";
import { SHA256_HEX } from "./update-manifest";

/**
 * Release-time core for the signed HOST FILES manifest: the compose file and the installer/updater scripts that
 * live in the operator's checkout (outside every container image) and that the in-app updater may replace when a
 * release changes them.
 *
 * A release publishes, next to `versions.json`, a directory `host/<version>/` holding
 *   HOSTFILES       the manifest below (plain text, LF, the exact bytes that are signed)
 *   HOSTFILES.sig   detached ed25519 signature (base64) over HOSTFILES, by the SAME publisher key as versions.json
 *   <path>          every file listed, at its repo-relative path
 * and the signed `versions.json` entry carries `hostFilesDigest` = sha256(HOSTFILES). The tugra-updater sidecar
 * re-verifies the signature itself (it never trusts the hub or Redis for file content) — see scripts/lib/hostfiles.sh,
 * which implements the SAME format and path rule in bash. Keep the two in lockstep (a jest spec drives the bash side
 * with output of this module).
 *
 * Wire format (one record per line, every line ends in "\n"):
 *   tugra-host-files v1
 *   version <release version>
 *   <64 lowercase hex sha256>  <path>        (sorted by path, two spaces — the `sha256sum` layout)
 *
 * The first line is a domain-separation prefix: a versions.json signature can never be replayed as a host-files
 * manifest (or the reverse) because the signed bytes of one can never be valid for the other.
 */

export const HOST_FILES_HEADER = "tugra-host-files v1";
export const HOST_FILES_MANIFEST_NAME = "HOSTFILES";
export const HOST_FILES_SIG_NAME = "HOSTFILES.sig";
export const MAX_HOST_FILES = 64;
export const MAX_HOST_FILE_BYTES = 1024 * 1024; // 1 MiB per file — scripts/compose are tens of KB
export const MAX_HOST_MANIFEST_BYTES = 16 * 1024;

/** Version charset (matches scripts/update.sh's version handling); also guards the `host/<version>/` path segment. */
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;

/**
 * Top-level files a release publishes. This is the PUBLISHER's selection (sign-host-files.mjs): `scripts/lib/*.sh` is
 * added automatically, and a jest spec asserts every name below exists so the list cannot rot. NOT included: `.env`
 * (the operator's configuration is never touched), Dockerfiles (they only matter for `--build`, a source checkout the
 * operator manages with git), maintainer/release tooling.
 */
export const HOST_TOP_LEVEL_FILES: readonly string[] = [
  "deploy/docker-compose.yml",
  "scripts/install.sh",
  "scripts/update.sh",
  "scripts/bootstrap.sh",
  "scripts/hub-migrate.sh",
];

/**
 * The CONSUMER's path rule (the sidecar enforces the very same one in bash): the compose file, or a shell script
 * directly under scripts/ or scripts/lib/. Structural (not an enumerated list) so a sidecar from an older release
 * still accepts a newer release's additional script, while nothing outside these two directories — and no `..`,
 * absolute path or odd character — can ever be written to the checkout.
 */
const SCRIPT_RE = /^scripts\/(lib\/)?[A-Za-z0-9][A-Za-z0-9._-]*\.sh$/;

/** Whether `p` is a path the host-files manifest may carry. */
export function isHostFilePath(p: string): boolean {
  if (typeof p !== "string" || p.includes("..")) return false;
  return p === "deploy/docker-compose.yml" || SCRIPT_RE.test(p);
}

export function isValidHostFilesVersion(v: string): boolean {
  return typeof v === "string" && v.length <= 64 && VERSION_RE.test(v);
}

export interface HostFileEntry {
  path: string;
  sha256: string; // bare lowercase 64-hex
}
export interface ParsedHostFiles {
  version: string;
  entries: HostFileEntry[];
}

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Build the manifest text for `version` from file contents keyed by repo-relative path. Throws on any bad input. */
export function buildHostFilesManifest(version: string, files: Record<string, Buffer | string>): string {
  if (!isValidHostFilesVersion(version)) throw new Error(`host files: invalid version "${version}"`);
  const paths = Object.keys(files).sort();
  if (paths.length === 0) throw new Error("host files: no files");
  if (paths.length > MAX_HOST_FILES) throw new Error(`host files: more than ${MAX_HOST_FILES} files`);
  const lines = [HOST_FILES_HEADER, `version ${version}`];
  for (const p of paths) {
    if (!isHostFilePath(p)) throw new Error(`host files: path not allowed: ${p}`);
    const data = files[p];
    const size = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
    if (size > MAX_HOST_FILE_BYTES) throw new Error(`host files: ${p} exceeds ${MAX_HOST_FILE_BYTES} bytes`);
    lines.push(`${sha256Hex(data)}  ${p}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Strict parser for the wire format (the same rules the bash side enforces). Throws on anything unexpected. */
export function parseHostFilesManifest(text: string): ParsedHostFiles {
  if (typeof text !== "string" || Buffer.byteLength(text) > MAX_HOST_MANIFEST_BYTES) throw new Error("host files: manifest too large");
  if (!text.endsWith("\n")) throw new Error("host files: manifest must end with a newline");
  const lines = text.slice(0, -1).split("\n");
  if (lines[0] !== HOST_FILES_HEADER) throw new Error("host files: bad header");
  const m = /^version (\S+)$/.exec(lines[1] ?? "");
  if (!m || !isValidHostFilesVersion(m[1])) throw new Error("host files: bad version line");
  const entries: HostFileEntry[] = [];
  const seen = new Set<string>();
  let prev = "";
  for (const line of lines.slice(2)) {
    const e = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line);
    if (!e || !SHA256_HEX.test(e[1])) throw new Error("host files: malformed entry line");
    const path = e[2];
    if (!isHostFilePath(path)) throw new Error(`host files: path not allowed: ${path}`);
    if (seen.has(path)) throw new Error(`host files: duplicate path ${path}`);
    if (path < prev) throw new Error("host files: entries not sorted");
    seen.add(path);
    prev = path;
    entries.push({ path, sha256: e[1] });
  }
  if (entries.length === 0) throw new Error("host files: no entries");
  if (entries.length > MAX_HOST_FILES) throw new Error("host files: too many entries");
  return { version: m[1], entries };
}

/** The value the signed versions.json carries as `hostFilesDigest`. */
export function hostFilesDigest(manifestText: string): string {
  return sha256Hex(manifestText);
}

/** Verify the detached signature over the EXACT manifest bytes, then parse. Throws on a bad signature. */
export function verifyHostFilesManifest(manifestText: string, sigB64: string, publisherKeyB64: string): ParsedHostFiles {
  if (typeof sigB64 !== "string" || Buffer.byteLength(sigB64) > 512) throw new Error("host files: signature too large");
  if (!verifyEd25519(publisherKeyB64, manifestText, sigB64.trim())) throw new Error("host files: bad signature");
  return parseHostFilesManifest(manifestText);
}
