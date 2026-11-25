/**
 * Runs the real generated shell (under sh) against fake binaries in a temp dir — no root, no systemd, no docker, no
 * host files — to prove the behaviour the lane is about:
 *  - a CHECK never configures/installs anything and reports an interrupted dpkg as a finding;
 *  - an APPLY runs as a host-side unit, survives its follower being killed, and re-attaches without a second unit;
 *  - without systemd the container-engine packages are refused.
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCheckScript, buildInstallPhasedScript, buildPatchRunScript, buildUpgradeAllScript, buildUpgradeExceptEngineScript, buildUpgradeOneScript, parsePatchRun, parseUpgradable } from "./patch-script";

// The shell under test (the host's /bin/sh is dash on Debian/Ubuntu); PATCH_TEST_SH=/bin/dash exercises that one.
const SH = process.env.PATCH_TEST_SH ?? "/bin/sh";

let root: string;
let bin: string;
let state: string;
let fake: string;
let sysd: string;
let tools: string;

// Only these host tools are visible to the scripts under test (symlinked from wherever this OS keeps them), so a
// real apt-get / dpkg / systemctl / timeout on the machine running the tests can never leak in.
const TOOLS = ["awk", "sed", "grep", "sort", "tr", "wc", "tail", "head", "find", "mkdir", "chmod", "cat", "base64", "sleep", "touch", "rm", "mv", "basename", "dirname", "ls", "printf", "sh"];

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

function envFor() {
  return { PATH: `${bin}:${tools}`, FAKE: fake };
}

function runSh(script: string, timeoutMs = 20_000) {
  return spawnSync(SH, ["-c", script], { env: envFor(), encoding: "utf8", timeout: timeoutMs });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tugra-patch-"));
  bin = join(root, "bin");
  state = join(root, "state");
  fake = join(root, "fake");
  sysd = join(root, "systemd");
  tools = join(root, "tools");
  for (const d of [bin, fake, sysd, tools]) mkdirSync(d, { recursive: true });
  for (const [t, found] of hostTools()) symlinkSync(found, join(tools, t));
  // `timeout [-k N] DURATION cmd…` without coreutils' timeout (absent on macOS): just exec cmd.
  put("timeout", 'while [ "$1" = "-k" ]; do shift 2; done; shift; exec "$@"');
  // systemd-run --unit U … /bin/sh SCRIPT: record the call, run SCRIPT in the background as "unit U".
  put(
    "systemd-run",
    [
      'echo "$@" >> "$FAKE/systemd-run.calls"',
      '[ -f "$FAKE/systemd-run.fail" ] && { echo "Failed to start transient unit" >&2; exit 1; }',
      '[ -f "$FAKE/systemd-run.noop" ] && exit 0',
      'unit=""; prev=""; for a in "$@"; do [ "$prev" = "--unit" ] && unit="$a"; prev="$a"; script="$a"; done',
      'touch "$FAKE/active-$unit"',
      '( /bin/sh "$script"; rm -f "$FAKE/active-$unit" ) >/dev/null 2>&1 &',
    ].join("\n"),
  );
  // An `active-<unit>` file is a running unit; its content is its ActiveState (empty = active). list-units honours
  // --state=a,b like the real one, so a guard that forgets "deactivating" is caught here.
  put(
    "systemctl",
    [
      'case "$1" in',
      '  is-active) if [ -f "$FAKE/active-$2" ]; then st=$(cat "$FAKE/active-$2"); echo "${st:-active}"; exit 0; else echo inactive; exit 3; fi ;;',
      "  list-units) want=active; for a in \"$@\"; do case \"$a\" in --state=*) want=${a#--state=} ;; esac; done",
      '    for f in "$FAKE"/active-*; do [ -e "$f" ] || continue; st=$(cat "$f"); st=${st:-active}',
      '      case ",$want," in *",$st,"*) echo "$(basename "$f" | sed s/^active-//).service loaded $st running" ;; esac; done; exit 0 ;;',
      "esac",
    ].join("\n"),
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const calls = () => (existsSync(join(fake, "systemd-run.calls")) ? readFileSync(join(fake, "systemd-run.calls"), "utf8").trim().split("\n").filter(Boolean) : []);
const ID = "a1b2c3d4e5f60718";
const opts = (o: Partial<Parameters<typeof buildPatchRunScript>[1]> = {}) => ({
  id: ID,
  deadlineSec: 60,
  lines: 0,
  guard: { kind: "all" as const },
  pollSec: "0.1",
  stateDir: state,
  systemdDir: sysd,
  ...o,
});

describe("CHECK under sh with fake apt/dpkg (read-only)", () => {
  function fakeApt(brokenLines: string) {
    put("apt-get", 'echo "apt-get $*" >> "$FAKE/calls"');
    put("apt", 'echo "apt $*" >> "$FAKE/calls"; echo "Listing..."; echo "docker-ce/noble 5:29.6.0 amd64 [upgradable from: 5:29.5.0]"');
    put("dpkg-query", `printf '%s\\n' ${brokenLines}`);
    put("dpkg", 'echo "dpkg $*" >> "$FAKE/calls"');
  }

  it("reports a half-configured docker-ce as its own finding and never runs dpkg or an install/upgrade", () => {
    fakeApt("'ii  openssl' 'iF  docker-ce' 'iU  containerd.io' 'ii  vim'");
    const r = runSh(buildCheckScript(sysd));
    expect(r.status).toBe(0);
    const info = parseUpgradable(r.stdout);
    expect(info.manager).toBe("apt");
    expect(info.count).toBe(1);
    expect(info.dpkgInterrupted).toEqual({
      packages: [
        { name: "docker-ce", state: "half-configured" },
        { name: "containerd.io", state: "unpacked" },
      ],
      containerEngine: true,
    });
    const log = readFileSync(join(fake, "calls"), "utf8");
    expect(log).not.toMatch(/^dpkg /m); // dpkg itself (configure) is never invoked — dpkg-query only reads
    expect(log).not.toMatch(/install|--configure|-f install/);
    expect(log.match(/^apt-get .*upgrade.*$/gm)).toEqual(["apt-get -s upgrade"]); // only ever simulated
    expect(log).toContain("apt-get update -qq"); // the index refresh is the only write
  });

  it("reports a phased package separately, from a real (simulated) apt-get -s upgrade, without upgrading anything", () => {
    put(
      "apt-get",
      [
        'echo "apt-get $*" >> "$FAKE/calls"',
        'case "$*" in *"-s upgrade"*) printf "%s\\n" "Reading package lists..." "Calculating upgrade..." "The following upgrades have been deferred due to phasing:" "  snapd" "0 upgraded, 0 newly installed, 0 to remove and 1 not upgraded." ;; esac',
      ].join("\n"),
    );
    put("apt", 'echo "Listing..."; echo "snapd/noble-updates 2.78 amd64 [upgradable from: 2.76.3]"; echo "vim/noble 2 amd64 [upgradable from: 1]"');
    put("dpkg-query", "true");
    const info = parseUpgradable(runSh(buildCheckScript(sysd)).stdout);
    expect(info.count).toBe(1);
    expect(info.packages.map((p) => p.name)).toEqual(["vim"]);
    expect(info.phased).toEqual([{ name: "snapd", group: "other", current: "2.76.3", candidate: "2.78" }]);
    expect(readFileSync(join(fake, "calls"), "utf8")).not.toMatch(/Always-Include-Phased/);
  });

  it("a non-engine interrupted package is reported without the engine flag; clean dpkg reports none", () => {
    fakeApt("'iF  vim'");
    expect(parseUpgradable(runSh(buildCheckScript(sysd)).stdout).dpkgInterrupted).toEqual({
      packages: [{ name: "vim", state: "half-configured" }],
      containerEngine: false,
    });
    fakeApt("'ii  vim' 'rc  old'");
    expect(parseUpgradable(runSh(buildCheckScript(sysd)).stdout).dpkgInterrupted).toBeNull();
  });

  it("flags a still-running apply unit and skips the index refresh so it cannot fight apt for the lock", () => {
    fakeApt("'ii  vim'");
    writeFileSync(join(fake, "active-tugra-patch-deadbeefdeadbeef"), "");
    const r = runSh(buildCheckScript(sysd));
    expect(parseUpgradable(r.stdout).applyRunning).toBe(true);
    expect(existsSync(join(fake, "calls")) ? readFileSync(join(fake, "calls"), "utf8") : "").not.toContain("update");
  });

  it("a unit that is deactivating (its kill window after the deadline) still counts as running", () => {
    fakeApt("'ii  vim'");
    writeFileSync(join(fake, "active-tugra-patch-deadbeefdeadbeef"), "deactivating");
    const r = runSh(buildCheckScript(sysd));
    expect(parseUpgradable(r.stdout).applyRunning).toBe(true);
    expect(existsSync(join(fake, "calls")) ? readFileSync(join(fake, "calls"), "utf8") : "").not.toContain("update");
  });
});

describe("APPLY inner script under sh with fake apt/dpkg", () => {
  function setup(brokenLines: string) {
    put("apt-get", 'echo "apt-get $*" >> "$FAKE/calls"');
    put("dpkg-query", `printf '%s\\n' ${brokenLines}`);
    put("dpkg", 'echo "dpkg $*" >> "$FAKE/calls"');
  }

  it("warns, then finishes dpkg, then upgrades — when dpkg is interrupted", () => {
    setup("'iF  docker-ce'");
    const r = runSh(buildUpgradeAllScript());
    expect(r.stdout).toContain("TUGRA_WARN: dpkg was interrupted (docker-ce )");
    const calls = readFileSync(join(fake, "calls"), "utf8").trim().split("\n");
    expect(calls[0]).toBe("dpkg --configure -a");
    expect(calls[1]).toContain("apt-get -o Dpkg::Options::=--force-confold upgrade -y");
  });

  it("does not touch dpkg --configure when nothing is interrupted", () => {
    setup("'ii  vim'");
    runSh(buildUpgradeOneScript("vim"));
    const calls = readFileSync(join(fake, "calls"), "utf8").trim().split("\n");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("install --only-upgrade -y vim");
  });
});

describe("forced phased install under sh with fake apt", () => {
  it("passes the phasing override to apt for that one package only", () => {
    put("apt-get", 'echo "apt-get $*" >> "$FAKE/calls"');
    put("dpkg-query", "true");
    put("dpkg", 'echo "dpkg $*" >> "$FAKE/calls"');
    runSh(buildInstallPhasedScript("snapd"));
    const calls = readFileSync(join(fake, "calls"), "utf8").trim().split("\n");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("-o APT::Get::Always-Include-Phased-Updates=true install --only-upgrade -y snapd");
    runSh(buildUpgradeOneScript("snapd"));
    const all = readFileSync(join(fake, "calls"), "utf8").trim().split("\n");
    expect(all[1]).not.toContain("Always-Include-Phased-Updates");
  });

  it("refuses without apt (phasing is an apt/Ubuntu concept)", () => {
    const r = runSh(buildInstallPhasedScript("snapd"));
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("TUGRA_PHASED_UNSUPPORTED");
  });
});

describe("APPLY driver: host-side unit + polling", () => {
  it("starts ONE unit, follows it, and reports the package manager's exit code after its output", () => {
    const r = runSh(buildPatchRunScript("echo one; echo two; exit 3", opts()));
    expect(r.status).toBe(0);
    const st = parsePatchRun(r.stdout);
    expect(st.mode).toBe("unit");
    expect(r.stdout).toContain("TUGRA_PATCH_STARTED");
    expect(st.log).toBe("one\ntwo\n");
    expect(st.rc).toBe(3);
    const c = calls();
    expect(c).toHaveLength(1);
    expect(c[0]).toContain(`--unit tugra-patch-${ID}`);
    expect(c[0]).toContain("--collect");
    // script, output and exit code live in the state dir (host files), not in the helper
    expect(readdirSync(state).sort()).toEqual(expect.arrayContaining([`${ID}.sh`, `${ID}.run`, `${ID}.log`, `${ID}.rc`]));
    expect(readFileSync(join(state, `${ID}.rc`), "utf8").trim()).toBe("3");
  });

  it("survives its follower being killed: re-attaching resumes after the lines it has and starts NO second unit", async () => {
    const inner = "echo one; sleep 2; echo two; exit 0";
    const first = spawn(SH, ["-c", buildPatchRunScript(inner, opts())], { env: envFor(), stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no first line, got: ${out}`)), 10_000);
      first.stdout.on("data", (d: Buffer) => {
        out += d.toString();
        if (out.includes("one\n")) {
          clearTimeout(t);
          resolve();
        }
      });
    });
    first.kill("SIGKILL"); // what an engine restart does to the helper container
    expect(existsSync(join(state, `${ID}.rc`))).toBe(false); // the unit is still mid-run
    const got = parsePatchRun(out);
    expect(got.log.startsWith("one\n")).toBe(true);
    const lines = 1;

    const second = runSh(buildPatchRunScript(inner, opts({ lines })));
    const st = parsePatchRun(second.stdout);
    expect(second.stdout).not.toContain("TUGRA_PATCH_STARTED"); // re-attached, did not start again
    expect(st.log).toBe("two\n"); // only what the hub does not have yet
    expect(st.rc).toBe(0);
    expect(calls()).toHaveLength(1); // one systemd-run for the whole apply
  }, 30_000); // several real shell runs; under full-suite load the default 5 s is too tight

  it("re-attaching after the unit already finished just replays the tail and the exit code", () => {
    runSh(buildPatchRunScript("echo hello; exit 5", opts()));
    const again = runSh(buildPatchRunScript("echo hello; exit 5", opts({ lines: 0 })));
    expect(parsePatchRun(again.stdout)).toMatchObject({ log: "hello\n", rc: 5 });
    expect(calls()).toHaveLength(1);
  });

  it("refuses to start while another patch unit is running (one package manager at a time)", () => {
    writeFileSync(join(fake, "active-tugra-patch-0000000000000000"), "");
    const r = runSh(buildPatchRunScript("echo never", opts()));
    expect(r.status).toBe(1);
    expect(parsePatchRun(r.stdout).busy).toBe(true);
    expect(calls()).toHaveLength(0);
    expect(existsSync(join(state, `${ID}.run`))).toBe(false);
  });

  it("refuses to start while the other patch unit is still deactivating (it holds the dpkg lock until it is gone)", () => {
    writeFileSync(join(fake, "active-tugra-patch-0000000000000000"), "deactivating");
    const r = runSh(buildPatchRunScript("echo never", opts()));
    expect(r.status).toBe(1);
    expect(parsePatchRun(r.stdout).busy).toBe(true);
    expect(calls()).toHaveLength(0);
  });

  it("resumes by line, so non-UTF-8 bytes and multibyte text cannot throw the resume point off", () => {
    // 0xE2 0x80 is the front half of a multibyte character: the hub decodes it to U+FFFD (3 bytes), so a byte offset
    // computed from the decoded text would not match the file. Lines do.
    const inner = "printf 'caf\\303\\251 \\342\\200 bad\\nsecond\\nthird\\n'; printf 'no-newline'; exit 0";
    runSh(buildPatchRunScript(inner, opts()));
    const resumed = runSh(buildPatchRunScript(inner, opts({ lines: 2 })));
    const st = parsePatchRun(resumed.stdout);
    expect(st.log).toBe("third\nno-newline"); // from line 3 on, including the unterminated last line
    expect(st.rc).toBe(0);
    expect(calls()).toHaveLength(1);
    const full = parsePatchRun(runSh(buildPatchRunScript(inner, opts({ lines: 0 }))).stdout);
    expect(full.log.split("\n")).toHaveLength(4);
  });

  it("reports a failed unit start and leaves no half-started state behind", () => {
    writeFileSync(join(fake, "systemd-run.fail"), "");
    const r = runSh(buildPatchRunScript("echo never", opts()));
    expect(r.status).toBe(1);
    expect(parsePatchRun(r.stdout).startFailed).toBe(true);
    expect(existsSync(join(state, `${ID}.run`))).toBe(false); // a retry may start it cleanly
  });

  it("a unit that vanishes without an exit code ends the follow with rc -1 instead of polling forever", () => {
    writeFileSync(join(fake, "systemd-run.noop"), ""); // systemd-run "succeeds" but nothing ever runs
    const r = runSh(buildPatchRunScript("echo never", opts()));
    expect(parsePatchRun(r.stdout).rc).toBe(-1);
  });
});

describe("APPLY driver without systemd: refuses the container engine", () => {
  const noSystemd = (o: Partial<Parameters<typeof buildPatchRunScript>[1]> = {}) => opts({ systemdDir: join(root, "no-such-dir"), ...o });
  function fakePending(lines: string[], brokenLines = "'ii  vim'") {
    put("apt-get", "exit 0");
    put("apt", `echo "Listing..."; ${lines.map((l) => `echo "${l}"`).join("; ")}`);
    put("dpkg-query", `printf '%s\\n' ${brokenLines}`);
  }

  it("upgrade-all with docker-ce pending is blocked, names it, and runs nothing", () => {
    fakePending(["docker-ce/noble 5:29.6.0 amd64 [upgradable from: 5:29.5.0]", "vim/noble 9.1 amd64 [upgradable from: 9.0]", "moby-engine/x 2 amd64 [upgradable from: 1]"]);
    const inner = `touch "${join(root, "ran")}"`;
    const r = runSh(buildPatchRunScript(inner, noSystemd()));
    expect(r.status).toBe(1);
    const st = parsePatchRun(r.stdout);
    expect(st.mode).toBe("inline");
    expect(st.engineBlocked).toEqual(["docker-ce", "moby-engine"]);
    expect(existsSync(join(root, "ran"))).toBe(false);
    expect(calls()).toHaveLength(0); // never started a unit either
  });

  it.each(["docker-ce", "docker-ce-cli", "containerd.io", "docker-buildx-plugin", "docker-compose-plugin", "moby-cli", "podman"])(
    "upgrade-one of %s is blocked",
    (pkg) => {
      fakePending([]);
      const r = runSh(buildPatchRunScript(`touch "${join(root, "ran")}"`, noSystemd({ guard: { kind: "one", pkg } })));
      expect(parsePatchRun(r.stdout).engineBlocked).toEqual([pkg]);
      expect(existsSync(join(root, "ran"))).toBe(false);
    },
  );

  it("a half-configured engine package blocks even an unrelated upgrade (the heal would re-run its postinst)", () => {
    fakePending([], "'iF  docker-ce'");
    const r = runSh(buildPatchRunScript(`touch "${join(root, "ran")}"`, noSystemd({ guard: { kind: "one", pkg: "vim" } })));
    expect(parsePatchRun(r.stdout).engineBlocked).toEqual(["docker-ce"]);
  });

  it("a non-engine upgrade still runs inline and reports its exit code", () => {
    fakePending(["vim/noble 9.1 amd64 [upgradable from: 9.0]"]);
    const r = runSh(buildPatchRunScript("echo upgrading vim; exit 0", noSystemd()));
    const st = parsePatchRun(r.stdout);
    expect(st).toMatchObject({ mode: "inline", engineBlocked: null, rc: 0 });
    expect(st.log).toContain("upgrading vim");
  });

  it("dnf-style pending names (name.arch) are matched too", () => {
    put("dnf", 'echo "docker-ce.x86_64   3:27.0   docker-ce-stable"; echo "curl.x86_64  7.76  baseos"');
    const r = runSh(buildPatchRunScript("echo no", noSystemd()));
    expect(parsePatchRun(r.stdout).engineBlocked).toEqual(["docker-ce.x86_64"]);
  });
});

describe("update all except the container engine, under sh with fake apt / dnf / apk", () => {
  let hold: string;
  let nrDir: string;
  const script = () => buildUpgradeExceptEngineScript({ holdFile: hold, needrestartDir: nrDir });
  const held = () => (existsSync(join(fake, "held")) ? readFileSync(join(fake, "held"), "utf8").trim().split("\n").filter(Boolean) : []);
  const calls = () => (existsSync(join(fake, "calls")) ? readFileSync(join(fake, "calls"), "utf8").trim().split("\n") : []);

  /** dpkg-query lists `pkgs` as installed ("ii") and `broken` with their given 2-letter state. */
  function fakeApt(opts: { pkgs: string[]; broken?: string[]; aptRc?: number; preHeld?: string[] }) {
    const lines = [...opts.pkgs.map((p) => `'ii  ${p}'`), ...(opts.broken ?? []).map((b) => `'${b}'`)].join(" ");
    put("dpkg-query", `printf '%s\\n' ${lines}`);
    put("dpkg", 'echo "dpkg $*" >> "$FAKE/calls"');
    writeFileSync(join(fake, "held"), (opts.preHeld ?? []).map((p) => `${p}\n`).join(""));
    put(
      "apt-mark",
      [
        'case "$1" in',
        '  showhold) cat "$FAKE/held" ;;',
        '  hold) echo "$2" >> "$FAKE/held"; echo "apt-mark hold $2" >> "$FAKE/calls" ;;',
        '  unhold) grep -vx -- "$2" "$FAKE/held" > "$FAKE/held.new"; mv "$FAKE/held.new" "$FAKE/held"; echo "apt-mark unhold $2" >> "$FAKE/calls" ;;',
        "esac",
      ].join("\n"),
    );
    put(
      "apt-get",
      [
        'echo "apt-get $* | held=$(tr "\\n" , < "$FAKE/held") | nrmode=$NEEDRESTART_MODE suspend=$NEEDRESTART_SUSPEND fe=$DEBIAN_FRONTEND | override=$(cat "' + "$NRDIR" + '/zz-tugra-keep-engine.conf" 2>/dev/null | tr "\\n" " ")" >> "$FAKE/calls"',
        `exit ${opts.aptRc ?? 0}`,
      ].join("\n"),
    );
  }

  beforeEach(() => {
    hold = join(root, "etc-tugra", "patch-engine-holds");
    nrDir = join(root, "needrestart");
    mkdirSync(nrDir, { recursive: true });
  });

  const run = (sc = script()) => spawnSync(SH, ["-c", sc], { env: { ...envFor(), NRDIR: nrDir }, encoding: "utf8", timeout: 20_000 });

  it("holds the installed engine packages while apt upgrades, then releases exactly those; needrestart cannot touch the engine", () => {
    fakeApt({ pkgs: ["openssl", "docker-ce", "docker-ce-cli", "containerd.io", "docker-model-plugin", "moby-engine", "vim"] });
    const r = run();
    expect(r.status).toBe(0);
    const c = calls();
    const upgrade = c.find((l) => l.startsWith("apt-get "))!;
    // during the upgrade every installed engine package was held, nothing else
    expect(upgrade).toContain("held=docker-ce,docker-ce-cli,containerd.io,docker-model-plugin,moby-engine,");
    expect(upgrade).toContain("upgrade -y");
    expect(upgrade).toContain("nrmode=l suspend=1 fe=noninteractive");
    expect(upgrade).toContain("qr(^docker)");
    expect(upgrade).toContain("qr(^containerd)");
    // afterwards: no holds left, no record, no needrestart override
    expect(held()).toEqual([]);
    expect(existsSync(hold)).toBe(false);
    expect(existsSync(join(nrDir, "zz-tugra-keep-engine.conf"))).toBe(false);
    expect(c.filter((l) => l.startsWith("apt-mark unhold")).sort()).toEqual(
      ["docker-ce", "docker-ce-cli", "containerd.io", "docker-model-plugin", "moby-engine"].map((p) => `apt-mark unhold ${p}`).sort(),
    );
  });

  it("restores the previous hold state: a package the admin already held stays held", () => {
    fakeApt({ pkgs: ["docker-ce", "containerd.io"], preHeld: ["containerd.io", "vim"] });
    expect(run().status).toBe(0);
    expect(held().sort()).toEqual(["containerd.io", "vim"]);
    expect(calls()).not.toContain("apt-mark hold containerd.io");
    expect(calls()).not.toContain("apt-mark unhold containerd.io");
  });

  it("releases the holds even when apt fails, and passes the failure's exit code on", () => {
    fakeApt({ pkgs: ["docker-ce"], aptRc: 100 });
    const r = run();
    expect(r.status).toBe(100);
    expect(held()).toEqual([]);
    expect(existsSync(hold)).toBe(false);
  });

  it("releases the holds when the run is terminated (TERM from the unit's timeout)", async () => {
    fakeApt({ pkgs: ["docker-ce"] });
    put("apt-get", 'echo "apt-get $*" >> "$FAKE/calls"; echo started > "$FAKE/started"; sleep 2');
    const child = spawn(SH, ["-c", script()], { env: { ...envFor(), NRDIR: nrDir }, stdio: "ignore" });
    const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
    for (let i = 0; i < 100 && !existsSync(join(fake, "started")); i++) await new Promise((r) => setTimeout(r, 50));
    expect(held()).toEqual(["docker-ce"]); // mid-run: held
    child.kill("SIGTERM");
    await exited;
    await new Promise((r) => setTimeout(r, 2500)); // the shell runs its trap once the sleeping child ends
    expect(held()).toEqual([]);
    expect(existsSync(hold)).toBe(false);
  }, 30_000);

  it("a hold left behind by a killed run is released by the NEXT apply (update all is not silently blocked)", () => {
    fakeApt({ pkgs: ["docker-ce", "openssl"], preHeld: ["docker-ce", "vim"] });
    mkdirSync(join(root, "etc-tugra"), { recursive: true });
    writeFileSync(hold, "docker-ce\n"); // the record a SIGKILLed except-engine run left
    writeFileSync(join(nrDir, "zz-tugra-keep-engine.conf"), "stale\n");
    const r = runSh(buildUpgradeAllScript().replace("HF='/etc/tugra/patch-engine-holds'", `HF='${hold}'`).replace("NRF='/etc/needrestart/conf.d/", `NRF='${nrDir}/`));
    expect(r.status).toBe(0);
    expect(held()).toEqual(["vim"]); // ours released, the admin's own hold untouched
    expect(existsSync(hold)).toBe(false);
    expect(existsSync(join(nrDir, "zz-tugra-keep-engine.conf"))).toBe(false);
    expect(calls().find((l) => l.startsWith("apt-get "))).toContain("upgrade -y");
  });

  it("never records or releases a name that is not an engine package", () => {
    fakeApt({ pkgs: ["docker-ce"], preHeld: ["docker-ce", "vim"] });
    mkdirSync(join(root, "etc-tugra"), { recursive: true });
    writeFileSync(hold, "vim\n$(touch /tmp/pwned)\n; reboot\n");
    expect(run().status).toBe(0);
    expect(held().sort()).toEqual(["docker-ce", "vim"]); // 'vim' in the record is ignored (not an engine name)
  });

  it("refuses without touching dpkg or apt when the engine is half-configured (finishing it would restart Docker)", () => {
    fakeApt({ pkgs: ["openssl"], broken: ["iF  docker-ce"] });
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("TUGRA_ERROR: dpkg left a container-engine package half-configured");
    expect(calls()).toEqual([]);
    expect(held()).toEqual([]);
  });

  it("a half-configured NON-engine package is still finished first, with the engine held", () => {
    fakeApt({ pkgs: ["docker-ce"], broken: ["iF  vim"] });
    expect(run().status).toBe(0);
    const c = calls();
    expect(c.indexOf("apt-mark hold docker-ce")).toBeLessThan(c.indexOf("dpkg --configure -a"));
    expect(c.indexOf("dpkg --configure -a")).toBeLessThan(c.findIndex((l) => l.startsWith("apt-get ")));
  });

  it("stops (and upgrades nothing) when a hold cannot be placed", () => {
    fakeApt({ pkgs: ["docker-ce"] });
    put("apt-mark", 'case "$1" in showhold) ;; hold) exit 1 ;; esac');
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("could not hold docker-ce");
    expect(calls().filter((l) => l.startsWith("apt-get "))).toEqual([]);
  });

  it("dnf: passes an --exclude for every engine package and nothing else is held", () => {
    put("dnf", 'echo "dnf $*" >> "$FAKE/calls"');
    expect(run().status).toBe(0);
    const line = calls()[0];
    expect(line).toMatch(/^dnf -y upgrade /);
    for (const n of ["docker-ce", "containerd.io", "docker-model-plugin", "moby-*"]) expect(line).toContain(`--exclude=${n}`);
  });

  it("apk: upgrades only the listed non-engine packages by name", () => {
    put("apk", 'if [ "$1" = version ]; then printf "%s\\n" "Installed:                                Available:" "docker-24.0.7-r0 < 25.0.0-r0" "zlib-1.2.13-r0 < 1.2.13-r1" "py3-foo-1.0-r2 < 1.1-r0" "containerd-1.7.0-r0 < 1.7.1-r0" "ca-certificates-20230506-r0 < 20240226-r0"; else echo "apk $*" >> "$FAKE/calls"; fi');
    expect(run().status).toBe(0);
    expect(calls()).toEqual(["apk upgrade zlib py3-foo ca-certificates"]);
  });

  it("apk: nothing left outside the engine is a clean no-op", () => {
    put("apk", 'if [ "$1" = version ]; then printf "%s\\n" "Installed: Available:" "docker-24.0.7-r0 < 25.0.0-r0"; else echo "apk $*" >> "$FAKE/calls"; fi');
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Nothing to upgrade outside the container engine");
    expect(calls()).toEqual([]);
  });

  it("the driver runs it as the host unit; inline mode does not refuse the engine for this scope", () => {
    fakeApt({ pkgs: ["docker-ce"] });
    const r = runSh(buildPatchRunScript(script(), { id: "a1b2c3d4e5f60718", deadlineSec: 60, lines: 0, guard: { kind: "except-engine" }, pollSec: "0.1", stateDir: state, systemdDir: sysd }));
    const st = parsePatchRun(r.stdout);
    expect(st.mode).toBe("unit");
    expect(st.engineBlocked).toBeNull();
  });
});
