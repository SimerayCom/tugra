import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateEd25519DeployKey } from "./ssh-keygen";

function sshKeygenAvailable(): boolean {
  try {
    execFileSync("ssh-keygen", ["-h"], { stdio: "ignore" });
    return true;
  } catch (e) {
    // -h exits non-zero but exists; treat "command not found" (ENOENT) as unavailable.
    return (e as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

describe("generateEd25519DeployKey", () => {
  it("produces an OpenSSH public-key line and a BEGIN OPENSSH PRIVATE KEY block", () => {
    const k = generateEd25519DeployKey();
    expect(k.publicKey).toMatch(/^ssh-ed25519 [A-Za-z0-9+/]+=* tugra$/);
    expect(k.privateKeyOpenSsh.startsWith("-----BEGIN OPENSSH PRIVATE KEY-----\n")).toBe(true);
    expect(k.privateKeyOpenSsh.endsWith("-----END OPENSSH PRIVATE KEY-----\n")).toBe(true);
    expect(k.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
  });

  it("two calls yield distinct keys", () => {
    expect(generateEd25519DeployKey().publicKey).not.toBe(generateEd25519DeployKey().publicKey);
  });

  // The real proof: OpenSSH must accept our hand-serialized private key and derive the SAME public key.
  (sshKeygenAvailable() ? it : it.skip)("OpenSSH parses the private key and derives the matching public key", () => {
    const k = generateEd25519DeployKey();
    const dir = mkdtempSync(join(tmpdir(), "tugra-ssh-"));
    try {
      const keyFile = join(dir, "id_ed25519");
      writeFileSync(keyFile, k.privateKeyOpenSsh, { mode: 0o600 });
      const derived = execFileSync("ssh-keygen", ["-y", "-f", keyFile]).toString().trim();
      // ssh-keygen -y prints "ssh-ed25519 <b64>" (no comment) — compare the key material.
      expect(derived.split(" ").slice(0, 2).join(" ")).toBe(k.publicKey.split(" ").slice(0, 2).join(" "));
      const fp = execFileSync("ssh-keygen", ["-lf", keyFile]).toString();
      expect(fp).toContain(k.fingerprint);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
