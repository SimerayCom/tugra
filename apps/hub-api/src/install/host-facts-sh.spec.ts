import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
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

  it("the served agent installer defines and runs it before starting the agent container", () => {
    const sh = renderAgentInstallScript({ image: "ghcr.io/simeraycom/tugra-agent:0.1.0-beta.25" });
    expect(sh).toContain("tugra_write_host_facts() {");
    const call = sh.indexOf("\ntugra_write_host_facts\n");
    expect(call).toBeGreaterThan(0);
    expect(call).toBeLessThan(sh.indexOf("docker run -d"));
  });
});
