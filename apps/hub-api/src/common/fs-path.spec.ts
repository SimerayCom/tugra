import { assertSafeFsPath } from "./fs-path";

describe("assertSafeFsPath", () => {
  it("accepts volume-relative paths (empty = root)", () => {
    for (const ok of ["", ".", "a", "a/b/c", "dir/file.txt", "a..b", "a.b"]) {
      expect(assertSafeFsPath(ok)).toBe(ok);
    }
  });

  it("rejects anything that could escape the volume or confuse the agent", () => {
    for (const bad of ["/etc/passwd", "/", "../x", "a/../../x", "a/..", "..", "a\\b", "a\0b"]) {
      expect(() => assertSafeFsPath(bad)).toThrow();
    }
  });

  it("rejects an over-long path", () => {
    expect(() => assertSafeFsPath("a".repeat(4097))).toThrow(/too long/);
  });
});
