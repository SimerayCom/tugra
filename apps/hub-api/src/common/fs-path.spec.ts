import { assertSafeCtrPath, assertSafeFsPath, assertSafeFsPathV2 } from "./fs-path";

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

describe("assertSafeFsPathV2 (strict fs2 path)", () => {
  it("accepts ordinary volume-relative paths", () => {
    for (const ok of ["a", "a/b/c", "dir/h\u00e9llo.txt", ".hidden", "a b/c", "-rf", "..a", "a..", ".tugra-par", "a".repeat(255)]) {
      expect(assertSafeFsPathV2(ok)).toBe(ok);
    }
  });

  it("the root is allowed only when asked for", () => {
    expect(assertSafeFsPathV2("", { allowRoot: true })).toBe("");
    expect(() => assertSafeFsPathV2("")).toThrow(/required/);
  });

  it("rejects control chars, escapes, empty and dot segments, and reserved names", () => {
    const bad = [
      "a\0b", "a\nb", "a\tb", "a\x7fb", "a\\b", "/etc/passwd", "a/../b", "../a", "a/./b", ".", "a//b", "a/",
      "a/" + "x".repeat(256), Array.from({ length: 65 }, () => "a").join("/"), "a".repeat(4097),
      ".tugra-part-0123456789abcdef", "a/.tugra-part-x/b", "a\ud800b",
    ];
    for (const p of bad) expect(() => assertSafeFsPathV2(p)).toThrow();
  });

  it("measures the length cap in UTF-8 bytes, not UTF-16 units", () => {
    expect(() => assertSafeFsPathV2("\u00e9".repeat(128))).toThrow(/segment too long/); // 128 chars = 256 bytes
    expect(assertSafeFsPathV2("\u00e9".repeat(127))).toBeTruthy(); // 254 bytes
  });
});

describe("assertSafeCtrPath", () => {
  it("accepts clean absolute paths", () => {
    for (const ok of ["/", "/app", "/etc/nginx/nginx.conf", "/app/a b/c", "/home/user/.cache"]) {
      expect(assertSafeCtrPath(ok)).toBe(ok);
    }
  });

  it("rejects relative, unclean, control-char and over-long paths", () => {
    for (const bad of ["app", "", "/a/../b", "/a/./b", "/a//b", "/a/", "/a\0b", "/a\nb", "/a\\b", "/" + "a".repeat(4096)]) {
      expect(() => assertSafeCtrPath(bad)).toThrow();
    }
  });

  it("denies /proc, /sys and /dev (and anything under them) but not look-alikes", () => {
    for (const bad of ["/proc", "/proc/1/environ", "/sys", "/sys/kernel", "/dev", "/dev/null"]) {
      expect(() => assertSafeCtrPath(bad)).toThrow(/not browsable/);
    }
    for (const ok of ["/procfs", "/system", "/devices", "/app/proc"]) expect(assertSafeCtrPath(ok)).toBe(ok);
  });

  it("refuses to mutate the container root but lets it be read", () => {
    expect(assertSafeCtrPath("/")).toBe("/");
    expect(() => assertSafeCtrPath("/", { mutating: true })).toThrow(/root/);
  });
});
