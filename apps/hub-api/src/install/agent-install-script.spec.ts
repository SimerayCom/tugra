import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderAgentInstallScript } from "./agent-install-script";

const IMAGE = "ghcr.io/mrcandev/tugra-agent:0.1.0";

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
});
