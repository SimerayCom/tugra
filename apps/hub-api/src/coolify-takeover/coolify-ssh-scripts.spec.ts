import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  COOLIFY_SSH_PROBE_SHA256,
  COOLIFY_SSH_UNINSTALL_SHA256,
  INSTALL_CID_MARK,
  INSTALL_OK_MARK,
  renderCoolifySshInstallScript,
} from "./coolify-ssh-scripts";

const AGENT_SCRIPTS = join(__dirname, "../../../../agent/internal/coolify/scripts");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const IMAGE = "ghcr.io/simeraycom/tugra-agent:1.2.3";

describe("pinned scripts", () => {
  it("names exactly the probe and uninstall scripts the agent embeds", () => {
    expect(sha(readFileSync(join(AGENT_SCRIPTS, "probe.sh"), "utf8"))).toBe(COOLIFY_SSH_PROBE_SHA256);
    expect(sha(readFileSync(join(AGENT_SCRIPTS, "uninstall.sh"), "utf8"))).toBe(COOLIFY_SSH_UNINSTALL_SHA256);
    expect(COOLIFY_SSH_PROBE_SHA256).not.toBe(COOLIFY_SSH_UNINSTALL_SHA256);
  });
});

describe("renderCoolifySshInstallScript", () => {
  const script = renderCoolifySshInstallScript(IMAGE);

  it("is valid POSIX sh", () => {
    expect(() => execFileSync("sh", ["-n"], { input: script })).not.toThrow();
  });

  it("wraps the whole installer in one function that is called last, with stdin closed", () => {
    const lines = script.trimEnd().split("\n");
    expect(lines[0]).toBe("tugra_install_main() {");
    expect(script.startsWith("#!")).toBe(false);
    const call = lines.findIndex((l) => l === 'tugra_install_main "$@" </dev/null');
    expect(call).toBeGreaterThan(0);
    // nothing but the two marks follows the call, and nothing runs outside the function before it
    expect(lines.slice(call + 1)).toEqual([expect.stringContaining(INSTALL_CID_MARK), `echo ${INSTALL_OK_MARK}`]);
    expect(lines.indexOf("}")).toBeGreaterThan(0);
  });

  it("prints the success marks only after the installer returned (set -e ends the shell first on any failure)", () => {
    expect(script).toContain("set -eu");
    expect(script.indexOf(INSTALL_OK_MARK)).toBeGreaterThan(script.indexOf('tugra_install_main "$@" </dev/null'));
  });

  it("carries no token and takes everything secret from the environment the agent prepends", () => {
    expect(script).not.toMatch(/tugra_en_[A-Za-z0-9_-]{8,}/);
    expect(script).toContain('TOKEN="${TUGRA_TOKEN:-}"');
    expect(script).toContain('HUB="${TUGRA_HUB:-}"');
    expect(script).toContain('HUB_PIN="${TUGRA_HUB_PIN:-}"');
    expect(script).toContain("TUGRA_SKIP_DOCKER_INSTALL");
  });

  it("takes the image from --image, which the agent sets to its own image", () => {
    expect(script).toContain("--image) IMAGE=");
  });

  it("is deterministic and release-specific", () => {
    expect(renderCoolifySshInstallScript(IMAGE)).toBe(script);
    expect(renderCoolifySshInstallScript("ghcr.io/simeraycom/tugra-agent:9.9.9")).not.toBe(script);
  });

  it("refuses an unsafe image reference", () => {
    expect(() => renderCoolifySshInstallScript('x"; rm -rf /; "')).toThrow();
  });

  it("does not remove or prune anything", () => {
    for (const banned of ["rm -rf", "docker system prune", "docker volume rm"]) expect(script).not.toContain(banned);
  });

  it("really runs: a stub docker makes the wrapped script print both marks, and a failing docker prints neither", () => {
    // Fed over `sh -s` exactly as the agent does (env prefix + body on stdin), with a stub `docker` first on PATH.
    const run = (dockerStub: string) => {
      const dir = join(require("node:os").tmpdir(), `cssh-${process.pid}-${Math.random().toString(36).slice(2)}`);
      require("node:fs").mkdirSync(dir, { recursive: true });
      require("node:fs").writeFileSync(join(dir, "docker"), dockerStub, { mode: 0o755 });
      const prefix = "export TUGRA_HUB='wss://hub.example.com/agent'\nexport TUGRA_TOKEN='tugra_en_AAAAAAAAAAAAAAAAAAAAAAAA'\nexport TUGRA_SKIP_DOCKER_INSTALL='1'\n";
      try {
        const out = execFileSync("sh", ["-s", "--", "--image", IMAGE], { input: prefix + script, env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir, TUGRA_HOST_FACTS_DIR: join(dir, "facts") }, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
        return { code: 0, out };
      } catch (e) {
        const err = e as { status: number; stdout: string };
        return { code: err.status, out: String(err.stdout ?? "") };
      }
    };
    const good = run('#!/bin/sh\ncase "$1" in inspect) echo ' + "a".repeat(64) + ' ;; *) exit 0 ;; esac\n');
    expect(good.code).toBe(0);
    expect(good.out).toContain(`${INSTALL_CID_MARK} ${"a".repeat(64)}`);
    expect(good.out).toContain(INSTALL_OK_MARK);
    const bad = run('#!/bin/sh\ncase "$1" in pull) exit 1 ;; *) exit 0 ;; esac\n');
    expect(bad.code).not.toBe(0);
    expect(bad.out).not.toContain(INSTALL_OK_MARK);
  });
});
