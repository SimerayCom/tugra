import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync as rf, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { HOST_FACTS_SH } from "./host-facts-sh";
import { renderAgentInstallScript } from "./agent-install-script";

const LIB = join(__dirname, "../../../../scripts/lib/hostfacts.sh");

describe("host facts snippet", () => {
  it("the hub's embedded copy is byte-identical to scripts/lib/hostfacts.sh", () => {
    expect(HOST_FACTS_SH).toBe(readFileSync(LIB, "utf8"));
  });

  it("writes valid JSON with sanitized fields, skipping docker interfaces (shimmed ip/hostname/os-release)", () => {
    const dir = mkdtempSync(join(tmpdir(), "hf-"));
    try {
      const bin = join(dir, "bin");
      spawnSync("mkdir", ["-p", bin]);
      const shim = (name: string, body: string) => {
        require("node:fs").writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
      };
      shim("hostname", `case "$1" in -I) echo "10.0.0.9 172.17.0.1";; *) printf '%s\\n' 'olgu-omer-ortak-new"evil';; esac`);
      shim(
        "ip",
        [
          "cat <<'EOF'",
          "2: eth0    inet 2.29.218.211/32 scope global dynamic eth0",
          "2: eth0    inet6 2a01:4f9:c014:8ecc::1/64 scope global",
          "3: docker0    inet 172.17.0.1/16 scope global docker0",
          "4: tailscale0    inet 100.85.166.104/32 scope global tailscale0",
          "5: br-abc    inet 172.18.0.1/16 scope global br-abc",
          "EOF",
        ].join("\n"),
      );
      const out = join(dir, "facts");
      const r = spawnSync("sh", ["-c", `. "${LIB}"; tugra_write_host_facts`], {
        env: { PATH: `${bin}:/usr/bin:/bin`, TUGRA_HOST_FACTS_DIR: out },
        encoding: "utf8",
      });
      expect(r.status).toBe(0);
      const facts = JSON.parse(rf(join(out, "host-facts.json"), "utf8"));
      expect(facts.source).toBe("install");
      expect(facts.hostname).toBe("olgu-omer-ortak-newevil"); // quote stripped, never breaks the JSON
      expect(facts.ips).toEqual(["2.29.218.211", "2a01:4f9:c014:8ecc::1", "100.85.166.104"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports the HASHED machine id only (sha256 of the versioned prefix and the id), never the raw id; none when there is no machine id", () => {
    const dir = mkdtempSync(join(tmpdir(), "hf-mid-"));
    try {
      const run = (idFile: string, out: string) =>
        spawnSync("sh", ["-c", `. "${LIB}"; tugra_write_host_facts`], { env: { PATH: "/usr/bin:/bin", TUGRA_HOST_FACTS_DIR: out, TUGRA_MACHINE_ID_FILE: idFile }, encoding: "utf8" });
      const raw = "0123456789abcdef0123456789abcdef";
      const idFile = join(dir, "machine-id");
      require("node:fs").writeFileSync(idFile, `${raw}\n`);
      const out1 = join(dir, "a");
      expect(run(idFile, out1).status).toBe(0);
      const text = rf(join(out1, "host-facts.json"), "utf8");
      const facts = JSON.parse(text);
      expect(facts.machineIdHash).toBe(createHash("sha256").update(`tugra-mid-v1${raw}`).digest("hex"));
      expect(text).not.toContain(raw);
      // no machine id on the host: the field is empty, the file is still valid
      const out2 = join(dir, "b");
      expect(run(join(dir, "missing"), out2).status).toBe(0);
      expect(JSON.parse(rf(join(out2, "host-facts.json"), "utf8")).machineIdHash).toBe("");
      // a too-short value is not an id
      require("node:fs").writeFileSync(idFile, "abc\n");
      const out3 = join(dir, "c");
      run(idFile, out3);
      expect(JSON.parse(rf(join(out3, "host-facts.json"), "utf8")).machineIdHash).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("sshd host key fingerprints (the machine's own, public keys only)", () => {
    const u32 = (n: number) => Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
    const ed25519Line = () => {
      const jwk = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }) as { x: string };
      const raw = Buffer.from(jwk.x, "base64url");
      const blob = Buffer.concat([u32(11), Buffer.from("ssh-ed25519"), u32(raw.length), raw]);
      return { line: `ssh-ed25519 ${blob.toString("base64")} root@host\n`, fp: `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}` };
    };
    const rsaLikeLine = () => {
      const blob = Buffer.concat([u32(7), Buffer.from("ssh-rsa"), Buffer.from("not really an rsa key, only bytes to hash".repeat(2))]);
      return { line: `ssh-rsa ${blob.toString("base64")} root@host\n`, fp: `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}` };
    };
    const run = (sshDir: string, out: string, env: Record<string, string> = {}) =>
      spawnSync("sh", ["-c", `. "${LIB}"; tugra_write_host_facts`], { env: { PATH: "/usr/bin:/bin", TUGRA_HOST_FACTS_DIR: out, TUGRA_SSH_HOST_KEY_DIR: sshDir, ...env }, encoding: "utf8" });
    const facts = (out: string) => JSON.parse(rf(join(out, "host-facts.json"), "utf8"));
    const has = (cmd: string) => spawnSync("sh", ["-c", `command -v ${cmd}`], { env: { PATH: "/usr/bin:/bin" } }).status === 0;

    it("reports the SHA256 fingerprint of the ed25519 host key first, then the others, and never the private key", () => {
      if (!has("ssh-keygen") && !has("openssl")) return; // neither tool on this machine: the field stays empty (covered below)
      const dir = mkdtempSync(join(tmpdir(), "hf-ssh-"));
      try {
        const ed = ed25519Line();
        require("node:fs").writeFileSync(join(dir, "ssh_host_ed25519_key.pub"), ed.line);
        require("node:fs").writeFileSync(join(dir, "ssh_host_ed25519_key"), "-----BEGIN OPENSSH PRIVATE KEY-----\nPRIVATE-CANARY\n");
        expect(run(dir, join(dir, "out")).status).toBe(0);
        const text = rf(join(dir, "out", "host-facts.json"), "utf8");
        expect(text).not.toContain("PRIVATE-CANARY");
        expect(facts(join(dir, "out"))).toMatchObject({ sshHostKeyFp: ed.fp, sshHostKeyFps: [ed.fp] });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("falls back to openssl when ssh-keygen is missing or says nothing, with the same fingerprint", () => {
      if (!has("openssl")) return;
      const dir = mkdtempSync(join(tmpdir(), "hf-ssh-"));
      try {
        const bin = join(dir, "bin");
        spawnSync("mkdir", ["-p", bin]);
        require("node:fs").writeFileSync(join(bin, "ssh-keygen"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
        const ed = ed25519Line();
        const rsa = rsaLikeLine();
        require("node:fs").writeFileSync(join(dir, "ssh_host_ed25519_key.pub"), ed.line);
        require("node:fs").writeFileSync(join(dir, "ssh_host_rsa_key.pub"), rsa.line);
        expect(run(dir, join(dir, "out"), { PATH: `${bin}:/usr/bin:/bin` }).status).toBe(0);
        expect(facts(join(dir, "out"))).toMatchObject({ sshHostKeyFp: ed.fp, sshHostKeyFps: [ed.fp, rsa.fp] });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("keeps only well-formed fingerprints: a malformed key file adds nothing and the file is still valid JSON", () => {
      const dir = mkdtempSync(join(tmpdir(), "hf-ssh-"));
      try {
        require("node:fs").writeFileSync(join(dir, "ssh_host_ed25519_key.pub"), "ssh-ed25519 !!!notbase64!!! x\n");
        require("node:fs").writeFileSync(join(dir, "ssh_host_ecdsa_key.pub"), "garbage\n");
        expect(run(dir, join(dir, "out")).status).toBe(0);
        expect(facts(join(dir, "out"))).toMatchObject({ sshHostKeyFp: "", sshHostKeyFps: [] });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("a host with no sshd keys (or no directory) reports none", () => {
      const dir = mkdtempSync(join(tmpdir(), "hf-ssh-"));
      try {
        expect(run(join(dir, "missing"), join(dir, "out")).status).toBe(0);
        expect(facts(join(dir, "out"))).toMatchObject({ sshHostKeyFp: "", sshHostKeyFps: [] });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it("the served agent installer defines and runs it before starting the agent container", () => {
    const sh = renderAgentInstallScript({ image: "ghcr.io/simeraycom/tugra-agent:0.1.0-beta.25" });
    expect(sh).toContain("tugra_write_host_facts() {");
    const call = sh.indexOf("\ntugra_write_host_facts\n");
    expect(call).toBeGreaterThan(0);
    expect(call).toBeLessThan(sh.indexOf("docker run -d"));
  });
});
