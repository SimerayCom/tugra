import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { renderMigratorInstallScript } from "./migrator-install-script";

const IMAGE = "ghcr.io/simeraycom/tugra-agent:0.1.0";
const TOK = "tugra_mig_" + "a".repeat(43); // 53 chars, matches tokenReExact

describe("renderMigratorInstallScript", () => {
  const script = renderMigratorInstallScript({ image: IMAGE });

  it("is a POSIX sh script with set -eu and no bashisms", () => {
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    expect(script).toContain("\nset -eu\n");
    expect(script).not.toContain("pipefail");
    expect(script).not.toContain("[[");
    expect(script).not.toContain("set -x");
  });

  it("is run from main() invoked on the last line (truncated download fails to parse, not half-run)", () => {
    const nonEmpty = script.split("\n").filter((l) => l.trim() !== "");
    expect(nonEmpty[nonEmpty.length - 1]).toBe('main "$@"');
  });

  it("NEVER puts the token on an argv: rejects --token, name-only -e, never echoes the token", () => {
    // `--token`/`--token-file` appear ONLY in the reject-case; no flag ever forwards a token to docker.
    expect(script).not.toMatch(/-e\s+TUGRA_MIGRATION_TOKEN=/); // never a value-bearing -e
    expect(script).toMatch(/-e TUGRA_MIGRATION_TOKEN\b/); // name-only: docker reads the value from its own env
    expect(script).not.toMatch(/(printf|echo)[^\n]*TUGRA_MIGRATION_TOKEN/); // never printed
    // the renderer takes no token input, so no full 53-char token can be embedded
    expect(script).not.toMatch(/tugra_mig_[A-Za-z0-9_-]{43}/);
  });

  it("hardens the container (cap-drop ALL, read-only, no-new-privileges, tmpfs spool, socket-only mount)", () => {
    expect(script).toContain("--cap-drop ALL");
    expect(script).toContain("--security-opt no-new-privileges");
    expect(script).toContain("--read-only");
    expect(script).toContain("--pids-limit");
    expect(script).toContain("--tmpfs /tmp:");
    expect(script).toContain("/spool:rw,noexec,nosuid,nodev");
    expect(script).toContain('--mount "type=bind,src=$SOCK,dst=/var/run/docker.sock"');
    expect(script).toContain("--entrypoint tugra-agent");
    expect(script).toContain('"$IMAGE" migrate "--hub=$HUB" --spool-dir=/spool "$@"');
  });

  it("is NOT privileged / not host-networked / not detached / not interactive", () => {
    expect(script).not.toContain("--privileged");
    expect(script).not.toContain("--network host");
    expect(script).not.toContain("--pid host");
    expect(script).not.toContain("--ipc host");
    expect(script).not.toMatch(/\s-d\b/);
    expect(script).not.toContain("--detach");
    expect(script).not.toMatch(/\s-it\b/);
    expect(script).not.toContain("--cap-add");
    expect(script).not.toContain("--restart");
    // the ONLY bind mount is the docker socket (the script uses --mount, never a -v volume flag; the lone
    // `-v` in the script is `command -v docker`, not a mount)
    const mounts = script.match(/--mount \S+|--volume \S+/g) ?? [];
    expect(mounts.length).toBeGreaterThan(0);
    for (const m of mounts) expect(m).toContain("docker.sock");
    expect(script).not.toMatch(/docker run[\s\S]*?\s-v /); // no short -v volume flag in the run
  });

  it("embeds the image and pins to a per-arch digest when supplied (before arg parse so --image wins)", () => {
    const A = "a".repeat(64);
    const B = "b".repeat(64);
    const pinned = renderMigratorInstallScript({ image: IMAGE, digests: { amd64: A, arm64: B } });
    expect(pinned).toContain(`x86_64|amd64) IMAGE="${IMAGE}@sha256:${A}" ;;`);
    expect(pinned.indexOf("uname -m")).toBeLessThan(pinned.indexOf("--image)"));
  });

  it("rejects an unsafe image ref / invalid digest (shared image-pin guards)", () => {
    expect(() => renderMigratorInstallScript({ image: "img; rm -rf /" })).toThrow(/unsafe image ref/);
    expect(() => renderMigratorInstallScript({ image: IMAGE, digests: { amd64: "short", arm64: "b".repeat(64) } })).toThrow(/invalid agent image digest/);
  });

  it("is valid POSIX shell (sh -n), bare and digest-pinned", () => {
    const A = "a".repeat(64);
    const pinned = renderMigratorInstallScript({ image: IMAGE, digests: { amd64: A, arm64: "b".repeat(64) } });
    const dir = mkdtempSync(join(tmpdir(), "migrator-sh-n-"));
    try {
      for (const [name, body] of [["bare.sh", script], ["pin.sh", pinned]] as const) {
        const f = join(dir, name);
        writeFileSync(f, body);
        expect(() => execFileSync("sh", ["-n", f], { stdio: "pipe" })).not.toThrow();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("behavioural (stub docker on PATH, a real temp socket, clean env)", () => {
    let dir: string;
    let scriptFile: string;
    let logFile: string;
    let sockPath: string;
    let server: net.Server;

    beforeAll((done) => {
      dir = mkdtempSync(join(tmpdir(), "migrator-run-"));
      scriptFile = join(dir, "migrator.sh");
      writeFileSync(scriptFile, script);
      logFile = join(dir, "stub.log");
      // A stub `docker` that records every call + the token it sees in its ENV (never from argv).
      const stub = join(dir, "docker");
      writeFileSync(
        stub,
        [
          "#!/bin/sh",
          'printf "CMD:%s\\n" "$1" >> "$STUB_LOG"',
          'for a in "$@"; do printf "ARG:%s\\n" "$a" >> "$STUB_LOG"; done',
          'if [ "$1" = run ]; then printf "ENV_TOKEN:%s\\n" "${TUGRA_MIGRATION_TOKEN:-}" >> "$STUB_LOG"; exit "${STUB_RUN_EXIT:-0}"; fi',
          'if [ "$1" = pull ]; then exit "${STUB_PULL_EXIT:-0}"; fi',
          "exit 0",
          "",
        ].join("\n"),
      );
      chmodSync(stub, 0o755);
      sockPath = join(dir, "d.sock");
      server = net.createServer();
      server.listen(sockPath, () => done());
    });

    afterAll(() => {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    });

    type Run = { code: number; stdout: string; stderr: string; log: string };
    const run = (args: string[], env: Record<string, string | undefined> = {}): Run => {
      const base: Record<string, string | undefined> = {
        PATH: `${dir}:/usr/bin:/bin`,
        STUB_LOG: logFile,
        TUGRA_DOCKER_SOCK: sockPath,
        TUGRA_MIGRATION_TOKEN: TOK,
        ...env,
      };
      writeFileSync(logFile, ""); // reset the stub log per run
      try {
        const stdout = execFileSync("sh", [scriptFile, ...args], { stdio: "pipe", env: base as NodeJS.ProcessEnv }).toString();
        return { code: 0, stdout, stderr: "", log: readFileSync(logFile, "utf8") };
      } catch (e) {
        const err = e as { status?: number; stderr?: Buffer; stdout?: Buffer };
        return { code: err.status ?? 1, stdout: err.stdout?.toString() ?? "", stderr: err.stderr?.toString() ?? "", log: readFileSync(logFile, "utf8") };
      }
    };

    it("happy path: pulls, reaps, runs `migrate` with forwarded flags; the token is on NO argv", () => {
      const r = run(["--hub", "https://hub.example.com", "--dry-run"]);
      expect(r.code).toBe(0);
      const args = r.log.split("\n").filter((l) => l.startsWith("ARG:")).map((l) => l.slice(4));
      // forwarded flags reach `migrate`
      expect(args).toEqual(expect.arrayContaining(["migrate", "--hub=https://hub.example.com", "--spool-dir=/spool", "--dry-run"]));
      // THE core S4-3 review finding, proven by execution: the token is on no docker argv
      for (const a of args) {
        expect(a).not.toContain("tugra_mig_");
        expect(a).not.toBe(TOK);
        expect(a).not.toBe("--token");
      }
      // name-only -e pair present (value comes from the env), and the stub actually received the token in its env
      expect(r.log).toContain("ARG:-e\nARG:TUGRA_MIGRATION_TOKEN\n");
      expect(r.log).toContain(`ENV_TOKEN:${TOK}`);
      // ordering: pull before run
      expect(r.log.indexOf("CMD:pull")).toBeGreaterThanOrEqual(0);
      expect(r.log.indexOf("CMD:pull")).toBeLessThan(r.log.indexOf("CMD:run"));
    });

    it("propagates migrate's exit code from the foreground run", () => {
      const r = run(["--hub", "https://hub.example.com"], { STUB_RUN_EXIT: "1" });
      expect(r.code).toBe(1);
    });

    it("rejects a --token flag (cannot reintroduce the argv leak) without echoing the value", () => {
      const r = run(["--hub", "https://hub.example.com", "--token", "SECRETVAL"]);
      expect(r.code).not.toBe(0);
      expect(r.stderr).not.toContain("SECRETVAL");
      expect(r.log).toBe(""); // died before any docker call
    });

    it("rejects SINGLE-dash flags (which Go's flag pkg accepts) so -token/-spool-dir can't leak or override", () => {
      // -token=<secret>: rejected, the secret is NOT echoed, nothing reaches docker
      const r1 = run(["--hub", "https://hub.example.com", "-token=SECRETVAL"]);
      expect(r1.code).not.toBe(0);
      expect(r1.stdout + r1.stderr).not.toContain("SECRETVAL");
      expect(r1.log).toBe("");
      // -spool-dir can't override the fixed tmpfs spool
      const r2 = run(["--hub", "https://hub.example.com", "-spool-dir=/data"]);
      expect(r2.code).not.toBe(0);
      expect(r2.log).toBe("");
      // but legitimate DOUBLE-dash forwarded flags still reach migrate
      const r3 = run(["--hub", "https://hub.example.com", "--only", "database:_:x"]);
      expect(r3.code).toBe(0);
      const args = r3.log.split("\n").filter((l) => l.startsWith("ARG:")).map((l) => l.slice(4));
      expect(args).toEqual(expect.arrayContaining(["--only", "database:_:x"]));
    });

    it("uses a unique per-run container name ($$) so concurrent runs don't reap each other", () => {
      const r = run(["--hub", "https://hub.example.com", "--dry-run"]);
      const nameArgs = r.log.split("\n").filter((l) => l.startsWith("ARG:")).map((l) => l.slice(4));
      const name = nameArgs[nameArgs.indexOf("--name") + 1];
      expect(name).toMatch(/^tugra-migrator-\d+$/);
    });

    it("requires the token in the env (names the var, never a value), before any docker call", () => {
      const r = run(["--hub", "https://hub.example.com"], { TUGRA_MIGRATION_TOKEN: undefined });
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("TUGRA_MIGRATION_TOKEN");
      expect(r.log).toBe("");
    });

    it("rejects a wrong-shape token (a PAT) before shipping it to the hub, without echoing it", () => {
      const r = run(["--hub", "https://hub.example.com"], { TUGRA_MIGRATION_TOKEN: "tugra_pat_" + "a".repeat(43) });
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("malformed migration token");
      expect(r.log).toBe("");
    });

    it("rejects a hostile / non-http --hub before any docker call", () => {
      for (const evil of ["http://x;id", "http://x$(id)", "ftp://x", "x", "http://x y"]) {
        const r = run(["--hub", evil]);
        expect(r.code).not.toBe(0);
        expect(r.log).toBe("");
      }
    });

    it("errors cleanly when --hub has no value (bounds-safe, not a shift crash)", () => {
      const r = run(["--hub"]);
      expect(r.code).not.toBe(0);
      expect(r.stderr).not.toMatch(/shift/i);
    });

    it("pull failure aborts before run; container reaped (--rm)", () => {
      const r = run(["--hub", "https://hub.example.com"], { STUB_PULL_EXIT: "1" });
      expect(r.code).toBe(6);
      expect(r.log).not.toContain("CMD:run");
    });
  });
});
