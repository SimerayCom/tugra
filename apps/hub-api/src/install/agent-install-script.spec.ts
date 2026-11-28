import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderAgentInstallScript } from "./agent-install-script";

const IMAGE = "ghcr.io/simeraycom/tugra-agent:0.1.0";

describe("renderAgentInstallScript", () => {
  const script = renderAgentInstallScript({ image: IMAGE });

  it("starts with a POSIX sh shebang and set -eu (no bashisms)", () => {
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    expect(script).toContain("\nset -eu\n");
    expect(script).not.toContain("pipefail"); // not POSIX — dash errors on it
    expect(script).not.toContain("[["); // no bash [[ ]] test
  });

  it("embeds the injected image and supports --image override", () => {
    expect(script).toContain(`IMAGE="${IMAGE}"`);
    expect(script).toContain("--image) IMAGE=");
  });

  it("parses --hub/--token and falls back to TUGRA_HUB/TUGRA_TOKEN env", () => {
    expect(script).toContain("--hub) HUB=");
    expect(script).toContain("--token) TOKEN=");
    expect(script).toContain('HUB="${TUGRA_HUB:-}"');
    expect(script).toContain('TOKEN="${TUGRA_TOKEN:-}"');
  });

  it("requires --hub and --token before doing anything", () => {
    expect(script).toContain('if [ -z "$HUB" ]; then');
    expect(script).toContain('if [ -z "$TOKEN" ]; then');
  });

  it("errors loudly (to stderr) when docker is missing, pointing at get.docker.com", () => {
    expect(script).toContain("if ! command -v docker");
    expect(script).toContain("get.docker.com");
    expect(script).toMatch(/Docker is required[\s\S]*>&2/);
  });

  it("auto-installs Docker when root (opt-out via TUGRA_SKIP_DOCKER_INSTALL), with a non-root guard", () => {
    expect(script).toContain("TUGRA_SKIP_DOCKER_INSTALL");
    expect(script).toContain('[ "$(id -u)" != "0" ]'); // only auto-installs as root
    expect(script).toContain("curl -fsSL https://get.docker.com | sh");
    expect(script).toMatch(/automatic Docker install failed/);
  });

  it("pulls the image and fails loudly if the pull fails", () => {
    expect(script).toContain('if ! docker pull "$IMAGE"; then');
    expect(script).toContain("could not pull");
  });

  it("runs the agent container matching the compose service (docker.sock, ~/.tugra volume, restart)", () => {
    expect(script).toContain("-v /var/run/docker.sock:/var/run/docker.sock");
    expect(script).toContain('-v "$VOLUME":/root/.tugra');
    expect(script).toContain("--restart unless-stopped");
    expect(script).toContain('-e TUGRA_HUB="$HUB"');
    expect(script).toContain('-e TUGRA_TOKEN="$TOKEN"');
    // optional traffic IP-mode knob: persisted under /etc/tugra and forwarded only when set
    expect(script).toContain("/etc/tugra/traffic-ip-mode");
    expect(script).toContain('${TUGRA_TRAFFIC_IP_MODE:+-e "TUGRA_TRAFFIC_IP_MODE=$TUGRA_TRAFFIC_IP_MODE"}');
  });

  it("is idempotent — removes any existing container first (volume keeps the agent identity)", () => {
    expect(script).toContain('docker rm -f "$NAME" >/dev/null 2>&1 || true');
  });

  it("rejects an unsafe image ref (defensive injection guard)", () => {
    expect(() => renderAgentInstallScript({ image: "img; rm -rf /" })).toThrow(/unsafe image ref/);
    expect(() => renderAgentInstallScript({ image: 'x"$(whoami)' })).toThrow(/unsafe image ref/);
  });

  describe("with per-arch digests (supply-chain pin)", () => {
    const A = "a".repeat(64);
    const B = "b".repeat(64);
    const pinned = renderAgentInstallScript({ image: IMAGE, digests: { amd64: A, arm64: B } });

    it("detects arch and pins IMAGE to image@sha256:<digest>", () => {
      expect(pinned).toContain('_arch="$(uname -m 2>/dev/null || echo unknown)"');
      expect(pinned).toContain(`x86_64|amd64) IMAGE="${IMAGE}@sha256:${A}" ;;`);
      expect(pinned).toContain(`aarch64|arm64) IMAGE="${IMAGE}@sha256:${B}" ;;`);
    });

    it("pins BEFORE arg parsing so --image still overrides", () => {
      expect(pinned.indexOf("uname -m")).toBeLessThan(pinned.indexOf("--image) IMAGE="));
      expect(pinned).toContain("--image) IMAGE=");
    });

    it("rejects an invalid (non-64-hex) digest", () => {
      expect(() => renderAgentInstallScript({ image: IMAGE, digests: { amd64: "short", arm64: B } })).toThrow(/invalid agent image digest/);
      expect(() => renderAgentInstallScript({ image: IMAGE, digests: { amd64: A, arm64: "ZZZ" } })).toThrow(/invalid agent image digest/);
    });

    it("is valid POSIX shell (sh -n) with the pin block", () => {
      const dir = mkdtempSync(join(tmpdir(), "agent-install-pin-"));
      const file = join(dir, "agent.sh");
      try {
        writeFileSync(file, pinned);
        expect(() => execFileSync("sh", ["-n", file], { stdio: "pipe" })).not.toThrow();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it("is valid POSIX shell syntax (sh -n)", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-install-"));
    const file = join(dir, "agent.sh");
    try {
      writeFileSync(file, script);
      // `sh -n` parses without executing — catches syntax errors / stray bashisms.
      expect(() => execFileSync("sh", ["-n", file], { stdio: "pipe" })).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("actually running the arg-validation (before any docker call)", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-install-run-"));
    const file = join(dir, "agent.sh");
    writeFileSync(file, script);
    // A clean env so a stray TUGRA_HUB/TUGRA_TOKEN on the CI box can't satisfy the checks.
    const cleanEnv = { PATH: process.env.PATH } as NodeJS.ProcessEnv;
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    const run = (args: string[]): { code: number; stderr: string } => {
      try {
        execFileSync("sh", [file, ...args], { stdio: "pipe", env: cleanEnv });
        return { code: 0, stderr: "" };
      } catch (e) {
        const err = e as { status?: number; stderr?: Buffer };
        return { code: err.status ?? 1, stderr: err.stderr?.toString() ?? "" };
      }
    };

    it("errors cleanly (not a shift crash) when --hub is given with no value", () => {
      const { code, stderr } = run(["--hub"]);
      expect(code).not.toBe(0);
      expect(stderr).toContain("--hub is required");
      expect(stderr).not.toMatch(/shift/i); // proves the bounds-safe shift, not a `shift 2` abort
    });

    it("errors cleanly when no args are supplied", () => {
      const { code, stderr } = run([]);
      expect(code).not.toBe(0);
      expect(stderr).toContain("--hub is required");
    });

    it("rejects an unknown option", () => {
      const { code, stderr } = run(["--bogus"]);
      expect(code).not.toBe(0);
      expect(stderr).toContain("unknown option --bogus");
    });
  });

  describe("transport policy (wss / pinned IP / explicit plaintext), run against a stub docker", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-install-tp-"));
    const file = join(dir, "agent.sh");
    const log = join(dir, "docker.log");
    writeFileSync(file, script);
    writeFileSync(join(dir, "docker"), `#!/bin/sh\necho "$@" >> "${log}"\nexit 0\n`, { mode: 0o755 });
    const env = { PATH: `${dir}:${process.env.PATH}` } as NodeJS.ProcessEnv;
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    const PIN = "sha256:" + "ab".repeat(32);

    const run = (args: string[]) => {
      rmSync(log, { force: true });
      const r = spawnSync("sh", [file, ...args, "--token", "tok"], { env, encoding: "utf8" });
      return { code: r.status ?? 1, stderr: r.stderr };
    };
    const dockerRun = () => {
      try {
        return readFileSync(log, "utf8").split("\n").find((l: string) => l.startsWith("run ")) ?? "";
      } catch {
        return "";
      }
    };

    it("a pinned wss://<ip> hub starts the agent with TUGRA_HUB_PIN", () => {
      const r = run(["--hub", "wss://203.0.113.7/agent", "--hub-pin", PIN]);
      expect(r.code).toBe(0);
      const line = dockerRun();
      expect(line).toContain("-e TUGRA_HUB=wss://203.0.113.7/agent");
      expect(line).toContain(`-e TUGRA_HUB_PIN=${PIN}`);
      expect(line).not.toContain("TUGRA_HUB_INSECURE");
    });

    it("a bare-IP wss hub without a pin is refused (no CA can vouch for it)", () => {
      const r = run(["--hub", "wss://203.0.113.7/agent"]);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("needs --hub-pin");
      expect(dockerRun()).toBe("");
    });

    it("a domain wss hub needs neither a pin nor an opt-in", () => {
      expect(run(["--hub", "wss://hub.example.com/agent"]).code).toBe(0);
      expect(dockerRun()).not.toContain("TUGRA_HUB_PIN");
    });

    it("plain ws:// to a public host is refused unless --hub-insecure is given, and then warns", () => {
      const refused = run(["--hub", "ws://203.0.113.7:3000/agent"]);
      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toContain("plain ws://");
      expect(dockerRun()).toBe("");
      const ok = run(["--hub", "ws://203.0.113.7:3000/agent", "--hub-insecure"]);
      expect(ok.code).toBe(0);
      expect(ok.stderr).toContain("WARNING: plain ws://");
      expect(dockerRun()).toContain("-e TUGRA_HUB_INSECURE=1");
    });

    it("a hub on this very machine (loopback): the agent shares the host's network, because localhost in a bridge container is the container", () => {
      for (const hub of ["ws://localhost:3000/agent", "ws://127.0.0.1:3000/agent", "ws://127.1.2.3:3000/agent"]) {
        const r = run(["--hub", hub]);
        expect(r.code).toBe(0);
        expect(dockerRun()).toContain("--network host");
        expect(r.stderr).toContain("host network");
      }
    });
    it("a hub reached by name or address is NOT given the host network (the default bridge stays)", () => {
      expect(run(["--hub", "ws://hub-api:3000/agent"]).code).toBe(0);
      expect(dockerRun()).not.toContain("--network host");
      expect(run(["--hub", "wss://hub.example.com/agent"]).code).toBe(0);
      expect(dockerRun()).not.toContain("--network host");
    });

    it("plain ws:// to localhost or a compose-internal name needs no opt-in", () => {
      expect(run(["--hub", "ws://localhost:3000/agent"]).code).toBe(0);
      expect(run(["--hub", "ws://hub-api:3000/agent"]).code).toBe(0);
      expect(run(["--hub", "ws://127.0.0.1:3000/agent"]).code).toBe(0);
      expect(run(["--hub", "ws://127.1.2.3:3000/agent"]).code).toBe(0);
    });

    it("a name that merely starts with 127. is a public host, not loopback (the agent would refuse it)", () => {
      const refused = run(["--hub", "ws://127.evil.example.com:3000/agent"]);
      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toContain("plain ws://");
      expect(run(["--hub", "ws://127.0.0.1.example.com/agent"]).code).not.toBe(0);
      expect(run(["--hub", "ws://127.evil.example.com:3000/agent", "--hub-insecure"]).code).toBe(0);
    });
  });
});
