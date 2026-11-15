import { describe, it, expect } from "vitest";
import {
  decodeForEdit, entryNameProblem, gridToMode, isCrlfOnly, isValidMode, joinPath, modeToGrid, modeToRwx, normalizeMode,
  parentPath, pathSegments, pathUpTo,
} from "./file-utils";

describe("entryNameProblem (one path segment typed by the user)", () => {
  it("accepts ordinary names, including dotfiles and unicode", () => {
    for (const ok of ["a", "notes.txt", ".env", "..a", "a..", "héllo 日本.txt", "x".repeat(255), "-rf", "a b"]) {
      expect(entryNameProblem(ok)).toBeNull();
    }
  });
  it("rejects empty, slashes, control characters, dot names, over-long and reserved names", () => {
    expect(entryNameProblem("")).toBe("empty");
    expect(entryNameProblem("a/b")).toBe("slash");
    expect(entryNameProblem("a\\b")).toBe("slash");
    expect(entryNameProblem("a\u0000b")).toBe("control");
    expect(entryNameProblem("a\nb")).toBe("control");
    expect(entryNameProblem("a\u007fb")).toBe("control");
    expect(entryNameProblem(".")).toBe("dot");
    expect(entryNameProblem("..")).toBe("dot");
    expect(entryNameProblem("x".repeat(256))).toBe("tooLong");
    expect(entryNameProblem("é".repeat(128))).toBe("tooLong"); // 256 UTF-8 bytes
    expect(entryNameProblem("é".repeat(127))).toBeNull();
    expect(entryNameProblem(".tugra-part-0123")).toBe("reserved");
  });
});

describe("path helpers", () => {
  it("joins, splits and rebuilds volume (relative) and container (absolute) paths", () => {
    expect(joinPath("volume", "", "a")).toBe("a");
    expect(joinPath("volume", "x/y", "a")).toBe("x/y/a");
    expect(joinPath("container", "/", "etc")).toBe("/etc");
    expect(joinPath("container", "/app", "f")).toBe("/app/f");
    expect(parentPath("volume", "a")).toBe("");
    expect(parentPath("volume", "a/b")).toBe("a");
    expect(parentPath("container", "/app")).toBe("/");
    expect(parentPath("container", "/app/x")).toBe("/app");
    expect(pathSegments("container", "/")).toEqual([]);
    expect(pathSegments("container", "/app/x")).toEqual(["app", "x"]);
    expect(pathSegments("volume", "")).toEqual([]);
    expect(pathUpTo("container", ["app", "x"], 1)).toBe("/app");
    expect(pathUpTo("volume", ["a", "b"], 2)).toBe("a/b");
  });
});

describe("permission grid <-> octal", () => {
  it("round-trips every mode from 000 to 777", () => {
    for (let n = 0; n <= 0o777; n++) {
      const s = n.toString(8).padStart(4, "0");
      expect(gridToMode(modeToGrid(s))).toBe(s);
    }
  });
  it("maps the familiar modes", () => {
    expect(modeToGrid("0644")).toEqual([{ r: true, w: true, x: false }, { r: true, w: false, x: false }, { r: true, w: false, x: false }]);
    expect(gridToMode(modeToGrid("755"))).toBe("0755");
    expect(modeToRwx("0640")).toBe("rw-r-----");
  });
  it("cannot represent or accept setuid/setgid/sticky", () => {
    expect(gridToMode(modeToGrid("4755"))).toBe("0755"); // special bit dropped on the way into the grid
    for (const bad of ["4755", "1777", "2755", "9", "0o7", "12", "01234", "", "0888"]) expect(isValidMode(bad)).toBe(false);
    for (const ok of ["644", "0644", "000", "0777", "755"]) expect(isValidMode(ok)).toBe(true);
    expect(normalizeMode("644")).toBe("0644");
  });
});

describe("text editing helpers", () => {
  const bytes = (s: string) => new TextEncoder().encode(s);
  it("accepts UTF-8 text, refuses NUL bytes in the first 8 KiB, and refuses invalid UTF-8", () => {
    expect(decodeForEdit(bytes("héllo\n"))).toEqual({ ok: true, text: "héllo\n" });
    expect(decodeForEdit(new Uint8Array([104, 0, 105]))).toEqual({ ok: false, reason: "binary" });
    expect(decodeForEdit(new Uint8Array([0xff, 0xfe, 0x41]))).toEqual({ ok: false, reason: "encoding" });
    const late = new Uint8Array(9000).fill(65);
    late[8500] = 0; // a NUL past the sniffed window is not "binary" by this rule (valid UTF-8 still)
    expect(decodeForEdit(late).ok).toBe(true);
    expect(decodeForEdit(new Uint8Array([]))).toEqual({ ok: true, text: "" });
  });
  it("keeps a UTF-8 byte-order mark (it must round-trip), and refuses files whose line endings are mixed or lone-CR", () => {
    const bom = decodeForEdit(new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x0a]));
    expect(bom).toEqual({ ok: true, text: "\ufeffa\n" });
    expect(Array.from(new TextEncoder().encode((bom as { text: string }).text))).toEqual([0xef, 0xbb, 0xbf, 0x61, 0x0a]);
    expect(decodeForEdit(bytes("a\r\nb\r\n"))).toEqual({ ok: true, text: "a\r\nb\r\n" }); // uniformly CRLF is fine
    expect(decodeForEdit(bytes("a\nb\n"))).toEqual({ ok: true, text: "a\nb\n" });
    expect(decodeForEdit(bytes("a\r\nb\n"))).toEqual({ ok: false, reason: "lineEndings" });
    expect(decodeForEdit(bytes("a\rb\r"))).toEqual({ ok: false, reason: "lineEndings" });
  });
  it("detects files whose every line break is CRLF (so they round-trip byte for byte)", () => {
    expect(isCrlfOnly("a\r\nb\r\n")).toBe(true);
    expect(isCrlfOnly("a\nb\n")).toBe(false);
    expect(isCrlfOnly("a\r\nb\n")).toBe(false);
    expect(isCrlfOnly("a\rb\r\n")).toBe(false);
    expect(isCrlfOnly("no breaks")).toBe(false);
  });
});
