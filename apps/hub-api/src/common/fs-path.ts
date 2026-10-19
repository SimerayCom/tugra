import { BadRequestException } from "@nestjs/common";

// maxFsPathLen bounds a volume-relative request path well under PATH_MAX, matching the agent's maxPathLen.
const MAX_FS_PATH_LEN = 4096;

/**
 * Validate a volume-relative file path (CASA-FILES) and return it unchanged. This is hub-side
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
