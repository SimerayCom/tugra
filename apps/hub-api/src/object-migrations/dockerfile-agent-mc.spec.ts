import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MC_INSTALL, MC_SHA256, MC_VERSION } from "../backups/destination";

const dockerfile = readFileSync(join(__dirname, "../../../../deploy/Dockerfile.agent"), "utf8");
const arg = (name: string): string | undefined => new RegExp(`^ARG ${name}=(\\S+)$`, "m").exec(dockerfile)?.[1];

describe("deploy/Dockerfile.agent vendors the pinned mc (drift guard)", () => {
  it("the three ARG defaults equal MC_VERSION / MC_SHA256 exported by destination.ts", () => {
    expect(arg("MC_VERSION")).toBe(MC_VERSION);
    expect(arg("MC_SHA256_AMD64")).toBe(MC_SHA256.amd64);
    expect(arg("MC_SHA256_ARM64")).toBe(MC_SHA256.arm64);
  });

  it("downloads the pinned asset, verifies the sha256 BEFORE chmod, and copies it into the final stage", () => {
    expect(dockerfile).toContain("FROM debian:bookworm-slim AS mc");
    expect(dockerfile).toContain('https://github.com/minio/mc/releases/download/${MC_VERSION}/mc.linux-${TARGETARCH}.${MC_VERSION}');
    const dl = dockerfile.indexOf("curl -fsSL");
    const sum = dockerfile.indexOf("sha256sum -c -");
    const chmod = dockerfile.indexOf("chmod 0755 /out/mc");
    expect(dl).toBeGreaterThan(0);
    expect(sum).toBeGreaterThan(dl);
    expect(chmod).toBeGreaterThan(sum);
    expect(dockerfile).toContain("COPY --from=mc /out/mc /usr/local/bin/mc");
    // an unsupported arch fails the build instead of shipping an unverified binary
    expect(dockerfile).toContain("unsupported arch");
  });

  it("documents the download URL, the version and the license in the Dockerfile", () => {
    expect(dockerfile).toMatch(/AGPL-3\.0/);
    expect(dockerfile).toContain("https://github.com/minio/mc/releases/download/");
    expect(dockerfile).toContain(MC_VERSION);
  });

  it("MC_INSTALL still works unchanged: it short-circuits on an image that already ships mc, and keeps the pinned download as fallback", () => {
    expect(MC_INSTALL.startsWith("command -v mc >/dev/null 2>&1 || {")).toBe(true);
    expect(MC_INSTALL).toContain(MC_VERSION);
    expect(MC_INSTALL).toContain(MC_SHA256.amd64);
    expect(MC_INSTALL).toContain(MC_SHA256.arm64);
  });

  it("NOTICE declares the vendored binary, its pinned release and license", () => {
    const notice = readFileSync(join(__dirname, "../../../../NOTICE"), "utf8");
    expect(notice).toContain("MinIO client (mc)");
    expect(notice).toContain(MC_VERSION);
    expect(notice).toMatch(/GNU Affero General Public License v3\.0/);
  });
});
