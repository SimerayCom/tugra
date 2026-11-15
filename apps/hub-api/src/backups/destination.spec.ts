import { MC_INSTALL, MC_VERSION, MC_SHA256 } from "./destination";

describe("mc install (supply-chain pinned + arch-aware)", () => {
  it("pins a specific mc RELEASE with 64-hex sha256 for both arches", () => {
    expect(MC_VERSION).toMatch(/^RELEASE\.\d{4}-\d{2}-\d{2}T/);
    expect(MC_SHA256.amd64).toMatch(/^[a-f0-9]{64}$/);
    expect(MC_SHA256.arm64).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps the command-exists guard (so it's a no-op when mc is already installed)", () => {
    expect(MC_INSTALL).toContain("command -v mc >/dev/null 2>&1 ||");
  });

  it("detects the arch and downloads the matching versioned binary", () => {
    expect(MC_INSTALL).toContain("$(uname -m)");
    expect(MC_INSTALL).toContain("x86_64|amd64) _p=amd64");
    expect(MC_INSTALL).toContain("aarch64|arm64) _p=arm64");
    expect(MC_INSTALL).toContain(`releases/download/${MC_VERSION}/mc.linux-`);
  });

  it("verifies the sha256 and never runs an unverified/foreign-arch binary", () => {
    expect(MC_INSTALL).toContain("sha256sum -c -");
    expect(MC_INSTALL).toContain(MC_SHA256.amd64);
    expect(MC_INSTALL).toContain(MC_SHA256.arm64);
    // a failed download/verify removes the file and aborts (so `mc` is never executed unverified)
    expect(MC_INSTALL).toContain("rm -f /usr/local/bin/mc; exit 1");
    // unsupported arch aborts rather than fetching a wrong binary
    expect(MC_INSTALL).toContain("unsupported arch");
  });

  it("fetches over https with -f (fail on HTTP error)", () => {
    expect(MC_INSTALL).toContain('curl -fsSL "https://github.com/minio/mc/releases/download/');
  });
});

describe("object-migration helpers share the backup quoting (no copy)", () => {
  it("mcHostEnv stays byte-identical to the pre-refactor output (alias tdest, whole value shq-quoted)", async () => {
    const { mcHostEnv, mcHostEnvFor, shq, endpointUrlStrict } = await import("./destination");
    const s3 = { bucket: "b", region: "r", endpoint: "s3.example.com", accessKey: "A'K!~", secretKey: "S$K`\\", prefix: "" };
    const url = new URL("https://s3.example.com");
    url.username = encodeURIComponent(s3.accessKey);
    url.password = encodeURIComponent(s3.secretKey);
    expect(mcHostEnv(s3)).toBe(`MC_HOST_tdest='${url.toString().replaceAll("'", "'\\''")}'`);
    // the raw pair carries the same URL, unquoted
    expect(mcHostEnvFor("tdest", s3)).toBe(`MC_HOST_tdest=${url.toString()}`);
    expect(shq("a'b")).toBe("'a'\\''b'");
    // an https default for scheme-less endpoints is kept for backups, refused for object migration
    expect(() => endpointUrlStrict("s3.example.com")).toThrow(/http/);
    expect(endpointUrlStrict("http://h:9000///")).toBe("http://h:9000");
  });
});
