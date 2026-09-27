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
});
