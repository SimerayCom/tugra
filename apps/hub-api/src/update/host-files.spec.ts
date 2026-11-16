import { generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  HOST_FILES_HEADER,
  HOST_TOP_LEVEL_FILES,
  MAX_HOST_FILES,
  buildHostFilesManifest,
  hostFilesDigest,
  isHostFilePath,
  isValidHostFilesVersion,
  parseHostFilesManifest,
  sha256Hex,
  verifyHostFilesManifest,
} from "./host-files";
import { derivePublicKeyB64, seedToPrivateKey, signDetached } from "./manifest-merge";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

function keypair() {
  const { privateKey } = generateKeyPairSync("ed25519");
  const seedB64 = Buffer.from(privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32)).toString("base64");
  const priv = seedToPrivateKey(seedB64);
  return { priv, publicKeyB64: derivePublicKeyB64(priv) };
}

describe("host-files manifest", () => {
  const files = {
    "deploy/docker-compose.yml": "name: tugra\n",
    "scripts/update.sh": "#!/usr/bin/env bash\n",
    "scripts/install.sh": "#!/usr/bin/env bash\necho hi\n",
    "scripts/lib/snapshot.sh": "# lib\n",
  };

  it("builds the exact wire format: header, version, sorted `sha256  path` lines, trailing newline", () => {
    const text = buildHostFilesManifest("0.2.0", files);
    const lines = text.split("\n");
    expect(lines[0]).toBe(HOST_FILES_HEADER);
    expect(lines[1]).toBe("version 0.2.0");
    expect(lines.slice(2, -1).map((l) => l.slice(66))).toEqual([
      "deploy/docker-compose.yml",
      "scripts/install.sh",
      "scripts/lib/snapshot.sh",
      "scripts/update.sh",
    ]);
    expect(lines[2]).toBe(`${sha256Hex("name: tugra\n")}  deploy/docker-compose.yml`);
    expect(text.endsWith("\n")).toBe(true);
    expect(buildHostFilesManifest("0.2.0", files)).toBe(text); // deterministic
  });

  it("round-trips through the strict parser", () => {
    const parsed = parseHostFilesManifest(buildHostFilesManifest("0.2.0-beta.3", files));
    expect(parsed.version).toBe("0.2.0-beta.3");
    expect(parsed.entries.map((e) => e.path)).toEqual(["deploy/docker-compose.yml", "scripts/install.sh", "scripts/lib/snapshot.sh", "scripts/update.sh"]);
  });

  it("path rule: only the compose file and scripts/ + scripts/lib/ shell scripts", () => {
    for (const ok of ["deploy/docker-compose.yml", "scripts/install.sh", "scripts/lib/hostfiles.sh", "scripts/new-tool.sh"]) {
      expect(isHostFilePath(ok)).toBe(true);
    }
    for (const bad of [
      ".env",
      "deploy/Dockerfile.hub",
      "deploy/docker-compose.yml.bak",
      "../scripts/install.sh",
      "scripts/../.env",
      "scripts/lib/../../.env",
      "/etc/passwd",
      "scripts/sub/dir.sh",
      "scripts/lib/deep/x.sh",
      "scripts/.hidden.sh",
      "scripts/install.mjs",
      "scripts/in stall.sh",
      "scripts\\install.sh",
      "scripts/install.sh\0",
      "",
    ]) {
      expect(isHostFilePath(bad)).toBe(false);
    }
  });

  it("refuses to BUILD a manifest with a disallowed path, a bad version, no files, too many or oversize files", () => {
    expect(() => buildHostFilesManifest("0.2.0", { ".env": "x" })).toThrow(/path not allowed/);
    expect(() => buildHostFilesManifest("0.2.0", { "scripts/../x.sh": "x" })).toThrow(/path not allowed/);
    expect(() => buildHostFilesManifest("../0.2.0", files)).toThrow(/invalid version/);
    expect(() => buildHostFilesManifest("0.2.0 x", files)).toThrow(/invalid version/);
    expect(() => buildHostFilesManifest("0.2.0", {})).toThrow(/no files/);
    const many = Object.fromEntries(Array.from({ length: MAX_HOST_FILES + 1 }, (_, i) => [`scripts/s${String(i).padStart(3, "0")}.sh`, "x"]));
    expect(() => buildHostFilesManifest("0.2.0", many)).toThrow(/more than/);
    expect(() => buildHostFilesManifest("0.2.0", { "scripts/big.sh": Buffer.alloc(1024 * 1024 + 1) })).toThrow(/exceeds/);
  });

  it("the strict parser rejects every malformed shape", () => {
    const good = buildHostFilesManifest("0.2.0", files);
    const h = "a".repeat(64);
    const bad: Array<[string, string]> = [
      ["no trailing newline", good.slice(0, -1)],
      ["wrong header", good.replace(HOST_FILES_HEADER, "tugra-host-files v2")],
      ["bad version line", good.replace("version 0.2.0", "version  0.2.0")],
      ["uppercase hex", good.replace(/[0-9a-f]{64}/, "A".repeat(64))],
      ["single-space separator", `${HOST_FILES_HEADER}\nversion 0.2.0\n${h} scripts/a.sh\n`],
      ["traversal path", `${HOST_FILES_HEADER}\nversion 0.2.0\n${h}  scripts/../.env\n`],
      ["absolute path", `${HOST_FILES_HEADER}\nversion 0.2.0\n${h}  /etc/passwd\n`],
      ["duplicate path", `${HOST_FILES_HEADER}\nversion 0.2.0\n${h}  scripts/a.sh\n${h}  scripts/a.sh\n`],
      ["unsorted", `${HOST_FILES_HEADER}\nversion 0.2.0\n${h}  scripts/b.sh\n${h}  scripts/a.sh\n`],
      ["no entries", `${HOST_FILES_HEADER}\nversion 0.2.0\n`],
      ["blank line", `${HOST_FILES_HEADER}\nversion 0.2.0\n\n${h}  scripts/a.sh\n`],
      ["trailing garbage", `${good}garbage\n`],
    ];
    for (const [name, text] of bad) {
      expect(() => parseHostFilesManifest(text)).toThrow(); // eslint-disable-line jest/valid-expect
      void name;
    }
    expect(() => parseHostFilesManifest("x".repeat(20_000) + "\n")).toThrow(/too large/);
  });

  it("verifies the detached ed25519 signature over the EXACT bytes; any change or a foreign key fails", () => {
    const { priv, publicKeyB64 } = keypair();
    const text = buildHostFilesManifest("0.2.0", files);
    const sig = signDetached(priv, text);
    expect(verifyHostFilesManifest(text, sig + "\n", publicKeyB64).version).toBe("0.2.0");
    expect(() => verifyHostFilesManifest(text.replace("0.2.0", "0.2.1"), sig, publicKeyB64)).toThrow(/bad signature/);
    expect(() => verifyHostFilesManifest(text, sig, keypair().publicKeyB64)).toThrow(/bad signature/);
    expect(() => verifyHostFilesManifest(text, "A".repeat(600), publicKeyB64)).toThrow(/too large/);
  });

  it("domain separation: a versions.json signature is never a valid host-files manifest signature", () => {
    const { priv, publicKeyB64 } = keypair();
    const versionsJson = JSON.stringify({ tugra: { stable: { version: "0.2.0" } } });
    const sigOverJson = signDetached(priv, versionsJson);
    expect(() => verifyHostFilesManifest(buildHostFilesManifest("0.2.0", files), sigOverJson, publicKeyB64)).toThrow(/bad signature/);
    // and the manifest text is never valid JSON, so the reverse replay is impossible too
    expect(() => JSON.parse(buildHostFilesManifest("0.2.0", files))).toThrow();
  });

  it("hostFilesDigest is sha256 of the manifest bytes", () => {
    const text = buildHostFilesManifest("0.2.0", files);
    expect(hostFilesDigest(text)).toBe(sha256Hex(text));
    expect(hostFilesDigest(text)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("version charset keeps the host/<version>/ path segment safe", () => {
    for (const ok of ["0.1.0", "0.1.0-beta.18", "1.2.3+build.5"]) expect(isValidHostFilesVersion(ok)).toBe(true);
    for (const bad of ["", ".", "..", "../x", "a/b", "a b", "-x", "x".repeat(65)]) expect(isValidHostFilesVersion(bad)).toBe(false);
  });

  describe("the real repository", () => {
    it("every published top-level file exists, and so does every scripts/lib/*.sh the runner auto-adds", () => {
      for (const p of HOST_TOP_LEVEL_FILES) {
        expect(existsSync(join(REPO_ROOT, p))).toBe(true);
        expect(isHostFilePath(p)).toBe(true);
      }
      const libs = readdirSync(join(REPO_ROOT, "scripts", "lib")).filter((n) => n.endsWith(".sh"));
      expect(libs).toContain("hostfiles.sh");
      for (const n of libs) expect(isHostFilePath(`scripts/lib/${n}`)).toBe(true);
    });

    it("a manifest built from the real checkout is accepted by the parser", () => {
      const real: Record<string, Buffer> = {};
      const libs = readdirSync(join(REPO_ROOT, "scripts", "lib")).filter((n) => n.endsWith(".sh")).map((n) => `scripts/lib/${n}`);
      for (const p of [...HOST_TOP_LEVEL_FILES, ...libs]) real[p] = readFileSync(join(REPO_ROOT, p));
      const parsed = parseHostFilesManifest(buildHostFilesManifest("0.0.0-test", real));
      expect(parsed.entries.length).toBe(HOST_TOP_LEVEL_FILES.length + libs.length);
    });

    it("the bash path rule in scripts/lib/hostfiles.sh is the same structural rule (no enumerated drift)", () => {
      const sh = readFileSync(join(REPO_ROOT, "scripts", "lib", "hostfiles.sh"), "utf8");
      expect(sh).toContain("deploy/docker-compose.yml");
      expect(sh).toContain("^scripts/(lib/)?[A-Za-z0-9][A-Za-z0-9._-]*[.]sh$");
      expect(sh).toContain(`HF_HEADER="${HOST_FILES_HEADER}"`);
      expect(sh).toContain(`HF_MAX_FILES=${MAX_HOST_FILES}`);
    });
  });
});
