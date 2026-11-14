import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { derivePublicKeyB64, seedToPrivateKey } from "./manifest-merge";
import { verifyUpdateManifest } from "./update-manifest";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const SIGN = join(REPO_ROOT, "scripts", "sign-manifest.mjs");
const KEYGEN = join(REPO_ROOT, "scripts", "keygen-publisher.mjs");
const DIST = join(REPO_ROOT, "apps", "hub-api", "dist", "update", "manifest-merge.js");

function seedKeypair(): { seedB64: string; publicKeyB64: string } {
  const { privateKey } = generateKeyPairSync("ed25519");
  const seedB64 = Buffer.from(privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32)).toString("base64");
  return { seedB64, publicKeyB64: derivePublicKeyB64(seedToPrivateKey(seedB64)) };
}

describe("scripts/*.mjs (manifest signer + keygen)", () => {
  it("both runners parse (node --check)", () => {
    expect(() => execFileSync("node", ["--check", SIGN], { stdio: "pipe" })).not.toThrow();
    expect(() => execFileSync("node", ["--check", KEYGEN], { stdio: "pipe" })).not.toThrow();
  });

  it("keygen output is a usable signing pair (the documented operator flow actually works)", () => {
    const out = execFileSync("node", [KEYGEN], { stdio: "pipe" }).toString().split("\n");
    const after = (label: string) => out[out.findIndex((l) => l.startsWith(label)) + 1].trim();
    const seedB64 = after("UPDATE_SIGNING_KEY");
    const pubB64 = after("UPDATE_PUBLISHER_KEY");
    // The printed public key is exactly the one derived from the printed seed.
    expect(derivePublicKeyB64(seedToPrivateKey(seedB64))).toBe(pubB64);
    expect(Buffer.from(pubB64, "base64").length).toBe(44);
    expect(Buffer.from(seedB64, "base64").length).toBe(32);
  });

  // The runner needs the compiled core; CI builds before test. Locally, skip until `pnpm build` has run.
  const e2e = existsSync(DIST) ? it : it.skip;
  e2e("sign-manifest.mjs writes a verifiable versions.json (no trailing newline) + preserves other channels", () => {
    const dir = mkdtempSync(join(tmpdir(), "sign-manifest-"));
    try {
      const { seedB64, publicKeyB64 } = seedKeypair();
      const currentPath = join(dir, "current.json");
      writeFileSync(currentPath, JSON.stringify({ tugra: { beta: { version: "0.9.0-beta.1", notes: "keep" } } }));

      execFileSync(
        "node",
        [
          SIGN,
          "--version", "0.2.0",
          "--channel", "stable",
          "--hub-image", "ghcr.io/simeraycom/tugra-hub:0.2.0",
          "--web-image", "ghcr.io/simeraycom/tugra-web:0.2.0",
          "--agent-amd64", "sha256:aabbcc",
          "--changelog-url", "https://github.com/SimerayCom/tugra/releases/tag/v0.2.0",
          "--current", currentPath,
          "--out-dir", dir,
        ],
        { stdio: "pipe", env: { ...process.env, UPDATE_SIGNING_KEY: seedB64 } },
      );

      const body = readFileSync(join(dir, "versions.json"), "utf8");
      const sig = readFileSync(join(dir, "versions.json.sig"), "utf8");
      expect(body.endsWith("\n")).toBe(false); // signed bytes = written bytes

      const verified = verifyUpdateManifest(body, sig, publicKeyB64);
      expect(verified.tugra.stable.version).toBe("0.2.0");
      expect(verified.tugra.stable.agentSha256).toEqual({ amd64: "aabbcc" }); // sha256: stripped
      expect(verified.tugra.beta).toEqual({ version: "0.9.0-beta.1", notes: "keep" }); // untouched
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  e2e("sign-manifest.mjs exits non-zero without UPDATE_SIGNING_KEY", () => {
    const env = { ...process.env };
    delete env.UPDATE_SIGNING_KEY;
    expect(() =>
      execFileSync("node", [SIGN, "--version", "0.2.0", "--channel", "stable"], { stdio: "pipe", env }),
    ).toThrow();
  });
  e2e("sign-manifest.mjs records imageDigests (sha256: stripped) and --require-digests gates hub+web", () => {
    const dir = mkdtempSync(join(tmpdir(), "sign-manifest-dg-"));
    try {
      const { seedB64, publicKeyB64 } = seedKeypair();
      const env = { ...process.env, UPDATE_SIGNING_KEY: seedB64 };
      const H = "a".repeat(64);
      const W = "b".repeat(64);
      const base = ["--version", "0.3.0", "--channel", "beta", "--out-dir", dir];

      execFileSync(
        "node",
        [SIGN, ...base, "--hub-digest", `sha256:${H}`, "--web-digest", W, "--updater-digest", "c".repeat(64), "--agent-index-digest", `sha256:${"d".repeat(64)}`, "--require-digests", "true"],
        { stdio: "pipe", env },
      );
      const v = verifyUpdateManifest(readFileSync(join(dir, "versions.json"), "utf8"), readFileSync(join(dir, "versions.json.sig"), "utf8"), publicKeyB64);
      expect(v.tugra.beta.imageDigests).toEqual({ hub: H, web: W, updater: "c".repeat(64), agent: "d".repeat(64) });

      const fails = (extra: string[]) => {
        try {
          execFileSync("node", [SIGN, ...base, ...extra], { stdio: "pipe", env });
          return null;
        } catch (e) {
          return (e as { status: number; stderr: Buffer });
        }
      };
      // --require-digests without hub+web → exit 1, nothing new written
      const missing = fails(["--hub-digest", H, "--require-digests", "true"]);
      expect(missing?.status).toBe(1);
      expect(String(missing?.stderr)).toMatch(/missing imageDigests for web/);
      // malformed digest → exit 1 at sign time
      const malformed = fails(["--hub-digest", "a".repeat(63), "--web-digest", W]);
      expect(malformed?.status).toBe(1);
      expect(String(malformed?.stderr)).toMatch(/imageDigests\.hub/);
      // a bare `--require-digests` with a non-`true` value must not silently disable the guard
      const sloppy = fails(["--require-digests", "yes"]);
      expect(sloppy?.status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
