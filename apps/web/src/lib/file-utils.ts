// Pure helpers for the file manager UI (no React, no network) so they are unit-testable in isolation.

const enc = new TextEncoder();

/** Entries the agent helper uses for in-flight uploads; never shown, never addressable. */
export const FS_PART_PREFIX = ".tugra-part-";

export type EntryNameProblem = "empty" | "slash" | "control" | "dot" | "tooLong" | "reserved";

/**
 * Validate ONE path segment typed by the user (new file/folder, rename). Mirrors the hub/agent rules for a single
 * segment: no "/", NUL or control characters, not "." or "..", at most 255 UTF-8 bytes, not the helper's temp prefix.
 * Returns null when valid.
 */
export function entryNameProblem(name: string): EntryNameProblem | null {
  if (name.length === 0) return "empty";
  if (name.includes("/") || name.includes("\\")) return "slash";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return "control";
  if (name === "." || name === "..") return "dot";
  if (enc.encode(name).length > 255) return "tooLong";
  if (name.startsWith(FS_PART_PREFIX)) return "reserved";
  return null;
}

/** Join a directory and an entry name for the given scope (volume paths are relative, container paths absolute). */
export function joinPath(scope: "volume" | "container", dir: string, name: string): string {
  if (scope === "container") return dir === "/" || dir === "" ? `/${name}` : `${dir}/${name}`;
  return dir ? `${dir}/${name}` : name;
}

/** The parent directory of a path (volume: "" is the root; container: "/" is the root). */
export function parentPath(scope: "volume" | "container", p: string): string {
  const i = p.lastIndexOf("/");
  if (scope === "container") return i <= 0 ? "/" : p.slice(0, i);
  return i < 0 ? "" : p.slice(0, i);
}

/** Path segments for a breadcrumb: volume "a/b" => ["a","b"]; container "/app/x" => ["app","x"]. */
export function pathSegments(scope: "volume" | "container", p: string): string[] {
  void scope;
  return p.split("/").filter((s) => s.length > 0);
}

/** Rebuild a path from the first `n` segments. */
export function pathUpTo(scope: "volume" | "container", segs: string[], n: number): string {
  const joined = segs.slice(0, n).join("/");
  return scope === "container" ? `/${joined}` : joined;
}

// ── permission bits ──────────────────────────────────────────────────────────────────────────────────────────

export type ModeGrid = { r: boolean; w: boolean; x: boolean }[]; // [owner, group, other]

/** "0644" / "644" => the 3x3 rwx grid. Special bits (setuid/setgid/sticky) are NOT representable and are dropped. */
export function modeToGrid(mode: string): ModeGrid {
  const v = parseInt(mode, 8);
  const bits = Number.isFinite(v) ? v & 0o777 : 0;
  return [6, 3, 0].map((shift) => {
    const d = (bits >> shift) & 7;
    return { r: (d & 4) !== 0, w: (d & 2) !== 0, x: (d & 1) !== 0 };
  });
}

/** The 3x3 grid => a 4-digit octal string ("0644"). */
export function gridToMode(grid: ModeGrid): string {
  const n = grid.reduce((acc, g) => (acc << 3) | ((g.r ? 4 : 0) | (g.w ? 2 : 0) | (g.x ? 1 : 0)), 0);
  return n.toString(8).padStart(4, "0");
}

/** An octal input is valid when it is 3-4 octal digits whose value is at most 0777 (no special bits). */
export function isValidMode(s: string): boolean {
  return /^[0-7]{3,4}$/.test(s) && parseInt(s, 8) <= 0o777;
}

/** Normalize a valid mode to 4 digits ("644" => "0644"). */
export function normalizeMode(s: string): string {
  return parseInt(s, 8).toString(8).padStart(4, "0");
}

/** "rwxr-xr-x" style string from an octal mode, for display. */
export function modeToRwx(mode: string): string {
  return modeToGrid(mode)
    .map((g) => `${g.r ? "r" : "-"}${g.w ? "w" : "-"}${g.x ? "x" : "-"}`)
    .join("");
}

// ── text editing ─────────────────────────────────────────────────────────────────────────────────────────────

/** True when every line break in `text` is CRLF (so it can be shown as LF and restored byte-for-byte on save). */
export function isCrlfOnly(text: string): boolean {
  return text.includes("\r\n") && !/(^|[^\r])\n/.test(text) && !/\r(?!\n)/.test(text);
}

export type DecodeResult = { ok: true; text: string } | { ok: false; reason: "binary" | "encoding" | "lineEndings" };

/**
 * Decode file bytes for the text editor: refuse anything with a NUL in its first 8 KiB (binary), that is not valid
 * UTF-8, or whose line endings are not uniformly LF or uniformly CRLF (a <textarea> normalizes line breaks, so a
 * mixed or lone-CR file would be rewritten on the first edit). A UTF-8 byte-order mark is KEPT as U+FEFF so it
 * round-trips. Never lossy — a file that does not round-trip must be downloaded, not edited.
 */
export function decodeForEdit(bytes: Uint8Array): DecodeResult {
  const head = bytes.subarray(0, 8192);
  for (let i = 0; i < head.length; i++) if (head[i] === 0) return { ok: false, reason: "binary" };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { ok: false, reason: "encoding" };
  }
  if (text.includes("\r") && !isCrlfOnly(text)) return { ok: false, reason: "lineEndings" };
  return { ok: true, text };
}
