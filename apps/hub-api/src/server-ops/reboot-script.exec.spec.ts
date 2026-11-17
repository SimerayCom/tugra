/**
 * Runs the real generated shell (under sh) against fake binaries in a temp dir: no root, no systemd, no docker, no host
 * files. Only the tools symlinked into the temp dir are visible, so a real systemctl / docker / curl on the machine
 * running the tests can never leak in. SH=/bin/dash (REBOOT_TEST_SH) exercises Debian's shell.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildBootIdScript,
  buildDomainProbeScript,
  buildRebootPreflightScript,
  buildRebootStartScript,
  buildRebootStateScript,
  parseDomainProbe,
  parseRebootHost,
  parseRebootStart,
  parseRebootState,
} from "./reboot-script";

const SH = process.env.REBOOT_TEST_SH ?? process.env.PATCH_TEST_SH ?? "/bin/sh";

let root: string;
let bin: string;
let fake: string;
let sysd: string;
let tools: string;

const TOOLS = ["awk", "sed", "grep", "sort", "tr", "wc", "tail", "head", "cat", "base64", "sleep", "rm", "printf", "xargs", "cut", "touch", "sh"];

let resolvedTools: [string, string][] | null = null;
function hostTools(): [string, string][] {
  resolvedTools ??= TOOLS.flatMap((t): [string, string][] => {
    const found = spawnSync("/bin/sh", ["-c", `command -v ${t}`], { encoding: "utf8" }).stdout.trim();
    return found.startsWith("/") ? [[t, found]] : [];
  });
  return resolvedTools;
}

function put(name: string, body: string) {
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
}

function runSh(script: string, env: Record<string, string> = {}) {
  return spawnSync(SH, ["-c", script], { env: { PATH: `${bin}:${tools}`, FAKE: fake, ...env }, encoding: "utf8", timeout: 20_000 });
}

const calls = (file: string) => (existsSync(join(fake, file)) ? readFileSync(join(fake, file), "utf8").trim().split("\n").filter(Boolean) : []);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tugra-reboot-"));
  bin = join(root, "bin");
  fake = join(root, "fake");
  sysd = join(root, "systemd");
  tools = join(root, "tools");
  for (const d of [bin, fake, sysd, tools]) mkdirSync(d, { recursive: true });
  for (const [t, found] of hostTools()) symlinkSync(found, join(tools, t));
  // systemd-run: record the call; `fail` makes it refuse; otherwise mark the unit's timer as active.
  put(
    "systemd-run",
    [
      'echo "$@" >> "$FAKE/systemd-run.calls"',
      '[ -f "$FAKE/systemd-run.fail" ] && { echo "Failed to start transient timer unit: Access denied" >&2; exit 1; }',
      'unit=""; prev=""; for a in "$@"; do [ "$prev" = "--unit" ] && unit="$a"; prev="$a"; done',
      'touch "$FAKE/active-$unit.timer"',
    ].join("\n"),
  );
  // systemctl: `is-active X` is true when active-X exists; list-units prints the active-*.service files (patch units).
  put(
    "systemctl",
    [
      'case "$1" in',
      '  is-active) [ -f "$FAKE/active-$2" ] && { echo active; exit 0; } || { echo inactive; exit 3; } ;;',
      '  list-units) for f in "$FAKE"/active-*.service; do [ -e "$f" ] || continue; b=$(basename "$f"); echo "${b#active-} loaded active running"; done; exit 0 ;;',
      "esac",
    ].join("\n"),
  );
  put("basename", 'x="${1##*/}"; echo "$x"');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("buildRebootStartScript under sh with fake systemd-run / systemctl", () => {
  it("arms ONE delayed reboot timer: systemd-run --on-active=15s systemctl reboot", () => {
    const r = runSh(buildRebootStartScript({ systemdDir: sysd }));
    expect(r.status).toBe(0);
    expect(parseRebootStart(r.stdout)).toMatchObject({ scheduled: true, alreadyPending: false, busy: null, unsupported: false, startFailed: false });
    const c = calls("systemd-run.calls");
    expect(c).toHaveLength(1);
    expect(c[0]).toContain("--unit tugra-reboot");
    expect(c[0]).toContain("--on-active=15s");
    expect(c[0]).toMatch(/systemctl reboot$/);
    // It never calls systemctl itself to reboot: the transient unit does, after the delay.
  });

  it("honours a custom delay and refuses an absurd one", () => {
    runSh(buildRebootStartScript({ systemdDir: sysd, delaySec: 45 }));
    expect(calls("systemd-run.calls")[0]).toContain("--on-active=45s");
    expect(() => buildRebootStartScript({ delaySec: 1 })).toThrow(/delay/);
    expect(() => buildRebootStartScript({ delaySec: 99999 })).toThrow(/delay/);
    expect(() => buildRebootStartScript({ systemdDir: "relative; rm -rf /" })).toThrow(/option/);
  });

  it("refuses while an OS update unit is running, and creates nothing", () => {
    writeFileSync(join(fake, "active-tugra-patch-abc123.service"), "");
    const r = runSh(buildRebootStartScript({ systemdDir: sysd }));
    expect(r.status).toBe(1);
    expect(parseRebootStart(r.stdout)).toMatchObject({ scheduled: false, busy: "patch" });
    expect(calls("systemd-run.calls")).toEqual([]);
  });

  it("is idempotent while an earlier reboot timer still counts down (no second unit)", () => {
    writeFileSync(join(fake, "active-tugra-reboot.timer"), "");
    const r = runSh(buildRebootStartScript({ systemdDir: sysd }));
    expect(r.status).toBe(0);
    expect(parseRebootStart(r.stdout)).toMatchObject({ scheduled: true, alreadyPending: true });
    expect(calls("systemd-run.calls")).toEqual([]);
  });

  it("reports systemd-run's refusal and its message", () => {
    writeFileSync(join(fake, "systemd-run.fail"), "");
    const r = runSh(buildRebootStartScript({ systemdDir: sysd }));
    expect(r.status).toBe(1);
    const res = parseRebootStart(r.stdout);
    expect(res).toMatchObject({ scheduled: false, startFailed: true });
    expect(r.stdout).toContain("Access denied");
  });

  it("refuses on a host without systemd (never falls back to an immediate reboot)", () => {
    const r = runSh(buildRebootStartScript({ systemdDir: join(root, "no-such-dir") }));
    expect(r.status).toBe(1);
    expect(parseRebootStart(r.stdout)).toMatchObject({ unsupported: true, scheduled: false });
    expect(calls("systemd-run.calls")).toEqual([]);
  });
});

describe("buildRebootPreflightScript (read-only)", () => {
  const flag = () => join(root, "reboot-required");
  const pre = () => buildRebootPreflightScript({ systemdDir: sysd, flagFiles: [flag()] });

  it("reads systemd, no patch, no pending reboot, flag clear", () => {
    const r = runSh(pre());
    expect(parseRebootHost(r.stdout)).toEqual({ systemd: true, patchRunning: false, pending: false, rebootRequired: false });
    expect(calls("systemd-run.calls")).toEqual([]); // read-only: nothing created
  });

  it("sees a running OS update, a pending reboot timer and the reboot-required flag", () => {
    writeFileSync(join(fake, "active-tugra-patch-1.service"), "");
    writeFileSync(join(fake, "active-tugra-reboot.timer"), "");
    writeFileSync(flag(), "");
    expect(parseRebootHost(runSh(pre()).stdout)).toEqual({ systemd: true, patchRunning: true, pending: true, rebootRequired: true });
  });

  it("asks needs-restarting on rpm hosts: exit 1 = reboot needed, exit 0 = not", () => {
    put("needs-restarting", 'exit "$(cat "$FAKE/nr")"');
    writeFileSync(join(fake, "nr"), "1");
    expect(parseRebootHost(runSh(pre()).stdout).rebootRequired).toBe(true);
    writeFileSync(join(fake, "nr"), "0");
    expect(parseRebootHost(runSh(pre()).stdout).rebootRequired).toBe(false);
  });

  it("reports no systemd", () => {
    const r = runSh(buildRebootPreflightScript({ systemdDir: join(root, "nope"), flagFiles: [flag()] }));
    expect(parseRebootHost(r.stdout).systemd).toBe(false);
  });
});

describe("agent-side state script", () => {
  const bootFile = () => join(root, "boot_id");

  function fakeDocker(inspectLines: string, daemon = true) {
    put(
      "docker",
      [
        'echo "docker $*" >> "$FAKE/docker.calls"',
        `case "$1" in`,
        `  info) ${daemon ? "exit 0" : "exit 1"} ;;`,
        `  ps) printf '%s\\n' c1 c2 ;;`,
        `  inspect) printf '%s\\n' ${inspectLines} ;;`,
        "esac",
      ].join("\n"),
    );
  }

  it("prints the boot id, docker state and one line per container, ending with the END marker", () => {
    writeFileSync(bootFile(), "1f0a-22b3\n");
    fakeDocker("'TUGRA_RB_C /web running healthy unless-stopped 0 nginx:1.27' 'TUGRA_RB_C /db running none always 0 postgres:16' 'TUGRA_RB_C /tmp exited none no 0 busybox' 'TUGRA_RB_C /svc.1.abc running none always 1 app:1'");
    const r = runSh(buildRebootStateScript({ bootIdFile: bootFile() }));
    const read = parseRebootState(r.stdout);
    expect(read).toMatchObject({ bootId: "1f0a-22b3", docker: true, complete: true });
    expect(read.containers.map((c) => [c.name, c.state, c.health, c.restartPolicy, c.swarm])).toEqual([
      ["web", "running", "healthy", "unless-stopped", false],
      ["db", "running", "none", "always", false],
      ["tmp", "exited", "none", "no", false],
      ["svc.1.abc", "running", "none", "always", true],
    ]);
    // only read-only docker commands
    expect(calls("docker.calls").every((l) => /^docker (info|ps -aq|inspect --format)/.test(l))).toBe(true);
  });

  it("reports docker inactive without touching ps/inspect", () => {
    writeFileSync(bootFile(), "abc\n");
    fakeDocker("", false);
    const read = parseRebootState(runSh(buildRebootStateScript({ bootIdFile: bootFile() })).stdout);
    expect(read).toMatchObject({ bootId: "abc", docker: false, complete: true, containers: [] });
    expect(calls("docker.calls")).toEqual(["docker info"]);
  });

  it("a docker line asking for a field the engine left empty cannot shift the others (policy defaults to no in the format)", () => {
    // The format itself uses {{or .HostConfig.RestartPolicy.Name "no"}}; assert the template carries it.
    expect(buildRebootStateScript()).toContain('{{or .HostConfig.RestartPolicy.Name "no"}}');
  });

  it("the boot-id script is just the boot id", () => {
    writeFileSync(bootFile(), "zz-9\n");
    expect(parseRebootState(runSh(buildBootIdScript({ bootIdFile: bootFile() })).stdout).bootId).toBe("zz-9");
  });

  it("a cut-off read is not complete", () => {
    expect(parseRebootState("TUGRA_RB_BOOT=a\nTUGRA_RB_DOCKER=active\nTUGRA_RB_C /web running none always 0 x\n").complete).toBe(false);
  });
});

describe("domain probe through a host-network helper container", () => {
  /** A fake `docker run ... -e K=V ... --entrypoint sh IMG -c SCRIPT`: exports the -e vars and runs SCRIPT under sh. */
  function fakeDockerRun() {
    put(
      "docker",
      [
        'echo "docker $*" >> "$FAKE/docker.calls"',
        '[ "$1" = run ] || exit 0',
        "shift",
        'script=""',
        "while [ $# -gt 0 ]; do",
        '  case "$1" in',
        '    -e) export "$2"; shift 2 ;;',
        '    -c) script="$2"; shift 2 ;;',
        "    *) shift ;;",
        "  esac",
        "done",
        'exec sh -c "$script"',
      ].join("\n"),
    );
  }
  // curl answers by host: *.down -> 000 (exit 7), *.nf -> 404, *.login -> 401, everything else 200.
  function fakeCurl() {
    put(
      "curl",
      [
        'echo "curl $*" >> "$FAKE/curl.calls"',
        'for a; do case "$a" in --resolve) r=1 ;; esac; done',
        'url=""; for a; do url="$a"; done',
        'host=${url#*://}; host=${host%%/*}',
        'case "$host" in *.down) exit 7 ;; *.nf) printf 404 ;; *.login) printf 401 ;; *) printf 200 ;; esac',
      ].join("\n"),
    );
  }

  const targets = [
    { host: "a.example.com", scheme: "https" as const, path: "/" },
    { host: "b.example.nf", scheme: "https" as const, path: "/" },
    { host: "c.example.down", scheme: "http" as const, path: "/" },
    { host: "d.example.login", scheme: "https" as const, path: "/app" },
  ];

  it("probes each host against 127.0.0.1 with --resolve and prints only status codes", () => {
    fakeDockerRun();
    fakeCurl();
    const r = runSh(buildDomainProbeScript(targets), { TUGRA_AGENT_IMAGE: "agent:test" });
    const read = parseDomainProbe(r.stdout);
    expect(read.complete).toBe(true);
    expect(read.unavailable).toBe(false);
    expect([...read.codes.entries()].sort()).toEqual([
      ["a.example.com", 200],
      ["b.example.nf", 404],
      ["c.example.down", 0],
      ["d.example.login", 401],
    ]);
    const cl = calls("curl.calls").join("\n");
    expect(cl).toContain("--resolve a.example.com:443:127.0.0.1 https://a.example.com/");
    expect(cl).toContain("--resolve c.example.down:80:127.0.0.1 http://c.example.down/"); // an http app is probed on :80
    expect(cl).toContain("https://d.example.login/app");
    const docker = calls("docker.calls").join("\n");
    expect(docker).toContain("--network host");
    expect(docker).toContain("--pull never");
  });

  it("says unavailable (never a fake answer) when the agent knows no image", () => {
    fakeDockerRun();
    fakeCurl();
    const r = runSh(buildDomainProbeScript(targets), { TUGRA_AGENT_IMAGE: "" });
    const read = parseDomainProbe(r.stdout);
    expect(read.unavailable).toBe(true);
    expect(read.codes.size).toBe(0);
    expect(calls("docker.calls")).toEqual([]);
  });

  it("drops hosts that are not safe curl arguments and caps the list", () => {
    fakeDockerRun();
    fakeCurl();
    const evil = [
      { host: "x.com; rm -rf /", scheme: "https" as const, path: "/" },
      { host: "ok.com", scheme: "https" as const, path: "/a b" },
      { host: "-oops.com", scheme: "https" as const, path: "/" },
      { host: "fine.example.com", scheme: "https" as const, path: "/" },
    ];
    const read = parseDomainProbe(runSh(buildDomainProbeScript(evil), { TUGRA_AGENT_IMAGE: "agent:test" }).stdout);
    expect([...read.codes.keys()]).toEqual(["fine.example.com"]);
  });
});
