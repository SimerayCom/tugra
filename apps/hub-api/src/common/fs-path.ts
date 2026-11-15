import { BadRequestException } from "@nestjs/common";
import { posix } from "node:path";

// maxFsPathLen bounds a volume-relative request path well under PATH_MAX, matching the agent's maxPathLen.
const MAX_FS_PATH_LEN = 4096;

/**
 * Validate a volume-relative file path and return it unchanged. This is hub-side
 * defense-in-depth: the agent's fsd helper re-validates and os.Root-confines everything, but rejecting
 * obviously-unsafe input here gives a clean 400 and keeps bad values off the wire. Mirrors the agent's
 * validatePath: no NUL, no backslash, no absolute path, no ".." segment, bounded length. "" means the root.
 */
export function assertSafeFsPath(path: string): string {
  if (typeof path !== "string") throw new BadRequestException("invalid path");
  if (path.length > MAX_FS_PATH_LEN) throw new BadRequestException("path too long");
  if (path.includes("\0")) throw new BadRequestException("path contains a NUL byte");
  if (path.includes("\\")) throw new BadRequestException("backslash is not allowed in a path");
  if (path.startsWith("/")) throw new BadRequestException("absolute paths are not allowed");
  if (path.split("/").some((seg) => seg === "..")) {
    throw new BadRequestException("'..' path segments are not allowed");
  }
  return path;
}

const MAX_SEGMENT_BYTES = 255;
const MAX_SEGMENTS = 64;
/** The agent helper's in-flight upload temp prefix; no user path may name one (mirrors the agent's partPrefix). */
export const FS_PART_PREFIX = ".tugra-part-";

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Strict volume-relative path check for the write-capable file protocol (fs2). Mirrors the agent's validatePath2:
 * everything assertSafeFsPath rejects, PLUS control characters, empty / "." segments (so no "//" and no trailing
 * slash), segments over 255 bytes, trees deeper than 64, lone surrogates (not well-formed UTF-16 => not valid UTF-8
 * on the wire) and the helper's reserved temp names. `allowRoot` permits "" (the volume root; stat only).
 * assertSafeFsPath stays untouched for the legacy list route.
 */
export function assertSafeFsPathV2(path: string, opts: { allowRoot?: boolean } = {}): string {
  if (typeof path !== "string") throw new BadRequestException("invalid path");
  if (path === "") {
    if (opts.allowRoot) return path;
    throw new BadRequestException("path is required");
  }
  if (Buffer.byteLength(path, "utf8") > MAX_FS_PATH_LEN) throw new BadRequestException("path too long");
  if (!isWellFormed(path)) throw new BadRequestException("path is not valid UTF-8");
  if (CONTROL_CHARS.test(path)) throw new BadRequestException("path contains a control character");
  if (path.includes("\\")) throw new BadRequestException("backslash is not allowed in a path");
  if (path.startsWith("/")) throw new BadRequestException("absolute paths are not allowed");
  const segs = path.split("/");
  if (segs.length > MAX_SEGMENTS) throw new BadRequestException("path is nested too deeply");
  for (const seg of segs) {
    if (seg === "" || seg === "." || seg === "..") throw new BadRequestException("empty, '.' and '..' path segments are not allowed");
    if (Buffer.byteLength(seg, "utf8") > MAX_SEGMENT_BYTES) throw new BadRequestException("path segment too long");
    if (seg.startsWith(FS_PART_PREFIX)) throw new BadRequestException("reserved name");
  }
  return path;
}

/** True when `s` has no lone UTF-16 surrogate (so it encodes to valid UTF-8). String#isWellFormed needs lib ES2024. */
function isWellFormed(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
}

const CTR_DENY = ["/proc", "/sys", "/dev"];

/**
 * Validate an absolute IN-CONTAINER path (container filesystem scope). Mirrors the agent's validateCtrPath:
 * absolute, already clean (no ".", "..", "//" or trailing slash except the bare "/"), no control characters,
 * bounded length, and never under /proc, /sys or /dev (all ops, reads included). `mutating` additionally refuses
 * "/" itself.
 */
export function assertSafeCtrPath(path: string, opts: { mutating?: boolean } = {}): string {
  if (typeof path !== "string" || !path.startsWith("/")) throw new BadRequestException("container path must be absolute");
  if (Buffer.byteLength(path, "utf8") > MAX_FS_PATH_LEN) throw new BadRequestException("path too long");
  if (!isWellFormed(path)) throw new BadRequestException("path is not valid UTF-8");
  if (CONTROL_CHARS.test(path)) throw new BadRequestException("path contains a control character");
  if (path.includes("\\")) throw new BadRequestException("backslash is not allowed in a path");
  if (posix.normalize(path) !== path || (path.length > 1 && path.endsWith("/"))) {
    throw new BadRequestException("path must be clean (no '.', '..', '//' or trailing slash)");
  }
  if (CTR_DENY.some((d) => path === d || path.startsWith(`${d}/`))) throw new BadRequestException("this location is not browsable");
  if (opts.mutating && path === "/") throw new BadRequestException("refusing to modify the container root");
  return path;
}
