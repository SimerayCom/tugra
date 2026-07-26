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
    expect(MC_INSTALL).toContain(`archive/mc.${MC_VERSION}`);
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
    expect(MC_INSTALL).toContain('curl -fsSL "https://dl.min.io/client/mc/release/linux-$_p/archive/mc.');
  });
});
