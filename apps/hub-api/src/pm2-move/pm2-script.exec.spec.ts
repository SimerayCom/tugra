/**
 * Runs the REAL generated cutover script under bash against fake `docker` / PM2 state in a temp dir (no docker, no PM2, no
 * root, no host files), to prove the control flow the lane is about:
 *   - the order: image first, THEN pm2 stop, THEN the container, THEN health, and only a healthy container removes the PM2 entry;
 *   - every failure after the stop puts PM2 back (rollback) and says what happened;
 *   - an outcome the script could not report is recovered without ever removing a live result.
 * The privileged host helper (nsenter) is replaced by functions over the same fake state; the host-side PM2 inner script is
 * exercised separately below with a fake pm2/runuser/id.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPm2MoveScript, buildPm2RecoverScript, hostPm2Inner, parsePm2MoveOutput, type Pm2ScriptInput } from "./pm2-script";

const BASE: Pm2ScriptInput = {
  appId: "cmapp1",
  user: "acme",
  home: "/home/acme",
  userUid: 1001,
  name: "my app",
  image: "node:20",
  interpreterDir: null,
  healthPort: 3000,
  probePath: null,
  tag: "tugra_cmapp1:dep1",
  runScript: "set -e\ndocker rm -f tugra_cmapp1 2>/dev/null || true\ndocker run -d --name tugra_cmapp1 node:20 node server.js",
};

let dir: string;
let bin: string;
let st: string;

const FAKE_DOCKER = `#!/bin/bash
S="$FAKE_STATE"
ev() { echo "$*" >> "$S/events"; }
flag() { [ -e "$S/$1" ]; }
pm2state() { cat "$S/pm2" 2>/dev/null; }
ctr() { cat "$S/ctr" 2>/dev/null || echo absent; }
port_open() { [ "$(pm2state)" = online ] || { [ "$(ctr)" = running ] && flag ctr_listens; } || flag foreign_listener; }
case "$1" in
  pull) ev docker:pull; flag pull_fail && { echo "pull failed" >&2; exit 1; }; exit 0;;
  tag) ev docker:tag; exit 0;;
  rmi) ev docker:rmi; exit 0;;
  rm) ev docker:rm; rm -f "$S/ctr"; exit 0;;
  logs) echo "listening on 3000"; echo "TUGRA_PM2MOVE: result=moved reason=ok"; echo "Error: EADDRINUSE"; printf 'ansi\\033[31mred\\n'; exit 0;;
  inspect)
    case "$*" in
      *"State.Running}} {{.RestartCount"*) if [ "$(ctr)" = running ]; then if flag crashloop; then echo "true 3"; else echo "true 0"; fi; else echo "false 0"; fi;;
      *"State.Running"*) if [ "$(ctr)" = running ]; then echo true; else echo false; fi;;
    esac; exit 0;;
  run)
    case "$*" in
      *"--entrypoint bash"*) ev docker:probe; if port_open; then exit 0; else exit 42; fi;;
      *"--entrypoint node"*) ev docker:http; cat "$S/http_code" 2>/dev/null || printf 200; exit 0;;
      *"-d --name"*) ev docker:run; flag run_fail && { echo "docker: Error response from daemon: Bind mount failed" >&2; exit 125; }
         if flag exits_immediately; then echo exited > "$S/ctr"; else echo running > "$S/ctr"; fi; echo cid; exit 0;;
    esac; exit 0;;
esac
exit 0
`;

/** `flock` itself is not on every dev machine: a fake whose "someone else holds it" is a flag file in the fake state. */
const FAKE_FLOCK = `#!/bin/bash
echo "flock $*" >> "$FAKE_STATE/events"
[ -e "$FAKE_STATE/lock_held" ] && exit 1
exit 0
`;

/** Replaces the privileged host helper with functions over the same fake state, and makes sleep instant. */
const FAKE_HOST = `
export PATH="$FAKE_BIN:$FAKE_ORIG_PATH"
sleep() { SECONDS=$((SECONDS + \${1%.*})); }
hx_pid() ( ev() { echo "$*" >> "$FAKE_STATE/events"; }; ev pm2:pid; [ -e "$FAKE_STATE/host_down" ] && { echo "TUGRA_HOST_UNAVAILABLE reason=no-nsenter"; exit 1; }; echo TUGRA_HOST_ENTERED
  s=$(cat "$FAKE_STATE/pm2" 2>/dev/null); if [ "$s" = online ]; then echo TUGRA_PM2_PID=4242; else echo TUGRA_PM2_PID=0; fi
  if [ "$s" = gone ] || [ -z "$s" ]; then echo TUGRA_PM2_EXISTS=0; else echo TUGRA_PM2_EXISTS=1; fi )
hx_stop() ( ev() { echo "$*" >> "$FAKE_STATE/events"; }; ev pm2:stop; echo TUGRA_HOST_ENTERED
  if [ -e "$FAKE_STATE/stop_fail" ]; then echo TUGRA_PM2_STOPPED=0; else echo stopped > "$FAKE_STATE/pm2"; echo TUGRA_PM2_STOPPED=1; fi )
hx_start() ( ev() { echo "$*" >> "$FAKE_STATE/events"; }; ev pm2:start; echo TUGRA_HOST_ENTERED
  if [ -e "$FAKE_STATE/start_fail" ]; then echo TUGRA_PM2_STARTED=0; else echo online > "$FAKE_STATE/pm2"; echo TUGRA_PM2_STARTED=1; fi )
hx_delete() ( ev() { echo "$*" >> "$FAKE_STATE/events"; }; ev pm2:delete; echo TUGRA_HOST_ENTERED
  if [ -e "$FAKE_STATE/delete_fail" ]; then echo TUGRA_PM2_DELETED=0; echo TUGRA_PM2_SAVED=0; else echo gone > "$FAKE_STATE/pm2"; echo TUGRA_PM2_DELETED=1; echo TUGRA_PM2_SAVED=1; fi )
`;

function withFakes(script: string): string {
  const i = script.indexOf("hxrun() {");
  if (i < 0) throw new Error("hxrun not found");
  return script.slice(0, i) + FAKE_HOST + script.slice(i);
}

interface World {
  pm2?: "online" | "stopped" | "gone";
  ctr?: "running" | "exited";
  flags?: string[];
  httpCode?: string;
}
function run(script: string, w: World = {}) {
  rmSync(st, { recursive: true, force: true });
  mkdirSync(st, { recursive: true });
  writeFileSync(join(st, "pm2"), w.pm2 ?? "online");
  if (w.ctr) writeFileSync(join(st, "ctr"), w.ctr);
  if (w.httpCode) writeFileSync(join(st, "http_code"), w.httpCode);
  for (const f of w.flags ?? []) writeFileSync(join(st, f), "");
  const r = spawnSync("bash", ["-c", withFakes(script)], { env: { PATH: process.env.PATH, TUGRA_PM2MOVE_LOCKDIR: join(dir, "lock"), FAKE_BIN: bin, FAKE_ORIG_PATH: process.env.PATH, FAKE_STATE: st, TUGRA_AGENT_IMAGE: "agent:1" }, encoding: "utf8", timeout: 60_000 });
  const events = existsSync(join(st, "events")) ? readFileSync(join(st, "events"), "utf8").trim().split("\n") : [];
  return {
    exit: r.status,
    out: r.stdout + r.stderr,
    outcome: parsePm2MoveOutput(r.stdout),
    events,
    pm2: readFileSync(join(st, "pm2"), "utf8").trim(),
    ctr: existsSync(join(st, "ctr")) ? readFileSync(join(st, "ctr"), "utf8").trim() : "absent",
  };
}
const idx = (events: string[], e: string) => events.indexOf(e);

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "pm2move-"));
  bin = join(dir, "bin");
  st = join(dir, "state");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "docker"), FAKE_DOCKER);
  chmodSync(join(bin, "docker"), 0o755);
  writeFileSync(join(bin, "flock"), FAKE_FLOCK);
  chmodSync(join(bin, "flock"), 0o755);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("the cutover script, run for real against fake docker and PM2 state", () => {
  const move = (over: Partial<Pm2ScriptInput> = {}) => buildPm2MoveScript({ ...BASE, ...over });

  it("is valid bash", () => {
    for (const s of [move(), move({ healthPort: null }), move({ probePath: "/health" }), buildPm2RecoverScript(BASE)]) {
      const r = spawnSync("bash", ["-n", "-c", s], { encoding: "utf8" });
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
    }
  });

  it("success: image first, then pm2 stop, then the container, then health, and only then pm2 delete", () => {
    const r = run(move(), { flags: ["ctr_listens"] });
    expect(r.outcome).toMatchObject({ result: "moved", reason: "ok", steps: ["precheck", "pull", "stop", "start", "health", "delete"] });
    expect(r.pm2).toBe("gone");
    expect(r.ctr).toBe("running");
    const e = r.events;
    expect(idx(e, "docker:pull")).toBeGreaterThan(idx(e, "pm2:pid"));
    expect(idx(e, "pm2:stop")).toBeGreaterThan(idx(e, "docker:pull"));
    expect(idx(e, "docker:run")).toBeGreaterThan(idx(e, "pm2:stop"));
    expect(idx(e, "pm2:delete")).toBeGreaterThan(idx(e, "docker:run"));
    expect(e.filter((x) => x === "pm2:start")).toHaveLength(0); // never restarted on the happy path
  });

  it("success with an HTTP probe that answers below 500 (404 counts: the app is up)", () => {
    const r = run(move({ probePath: "/health" }), { flags: ["ctr_listens"], httpCode: "404" });
    expect(r.outcome.result).toBe("moved");
    expect(r.events).toContain("docker:http");
  });

  it("an HTTP probe that answers 500 rolls back", () => {
    const r = run(move({ probePath: "/health" }), { flags: ["ctr_listens"], httpCode: "500" });
    expect(r.outcome).toMatchObject({ result: "rolled_back", reason: "http_failed" });
    expect(r.pm2).toBe("online");
    expect(r.ctr).toBe("absent");
  });

  it("no known port: a container that keeps running without restarts is accepted", () => {
    const r = run(move({ healthPort: null }));
    expect(r.outcome.result).toBe("moved");
    expect(r.events).not.toContain("docker:probe");
  });

  it("no known port: a crash-looping container is rolled back", () => {
    const r = run(move({ healthPort: null }), { flags: ["crashloop"] });
    expect(r.outcome).toMatchObject({ result: "rolled_back", reason: "container_exited" });
    expect(r.pm2).toBe("online");
  });

  it("not online in PM2: nothing is touched", () => {
    const r = run(move(), { pm2: "stopped" });
    expect(r.outcome).toMatchObject({ result: "aborted", reason: "not_online" });
    expect(r.events).not.toContain("pm2:stop");
    expect(r.events).not.toContain("docker:pull");
  });

  it("host helper unavailable: aborted before anything changes", () => {
    const r = run(move(), { flags: ["host_down"] });
    expect(r.outcome).toMatchObject({ result: "aborted", reason: "host_unavailable" });
    expect(r.events).not.toContain("pm2:stop");
  });

  it("image pull fails: aborted with PM2 untouched (no downtime was ever taken)", () => {
    const r = run(move(), { flags: ["pull_fail"] });
    expect(r.outcome).toMatchObject({ result: "aborted", reason: "pull_failed" });
    expect(r.events).not.toContain("pm2:stop");
    expect(r.pm2).toBe("online");
  });

  it("pm2 stop fails: aborted, and PM2 is told to start the process again", () => {
    const r = run(move(), { flags: ["stop_fail"] });
    expect(r.outcome).toMatchObject({ result: "aborted", reason: "stop_failed" });
    expect(r.events).toContain("pm2:start");
    expect(r.events).not.toContain("docker:run");
    expect(r.pm2).toBe("online");
  });

  it("a foreign listener keeps the port after the stop: rolled back before any container starts", () => {
    const r = run(move(), { flags: ["foreign_listener"] });
    expect(r.outcome).toMatchObject({ result: "rolled_back", reason: "port_busy" });
    expect(r.events).not.toContain("docker:run");
    expect(r.pm2).toBe("online");
  });

  it("docker run fails: rolled back, PM2 restarted, the docker error is reported (prefixed)", () => {
    const r = run(move(), { flags: ["run_fail"] });
    expect(r.outcome).toMatchObject({ result: "rolled_back", reason: "start_failed" });
    expect(r.outcome.errTail.join(" ")).toContain("Bind mount failed");
    expect(r.pm2).toBe("online");
    expect(r.ctr).toBe("absent");
    expect(r.events).toEqual(expect.arrayContaining(["docker:rmi", "pm2:start"]));
  });

  it("the container never listens: rolled back after the window, PM2 restarted, container removed", () => {
    const r = run(move({ healthTimeoutSec: 10 }), {});
    expect(r.outcome).toMatchObject({ result: "rolled_back", reason: "not_listening" });
    expect(r.pm2).toBe("online");
    expect(r.ctr).toBe("absent");
    // The app's own output is shown prefixed, and a line that imitates the protocol does not become the result.
    expect(r.outcome.logTail).toContain("TUGRA_PM2MOVE: result=moved reason=ok");
    expect(r.out).toContain("TUGRA_PM2MOVE_LOG: TUGRA_PM2MOVE: result=moved reason=ok");
  });

  it("the container exits right after start: rolled back (container_exited)", () => {
    const r = run(move(), { flags: ["exits_immediately"] });
    expect(r.outcome).toMatchObject({ result: "rolled_back", reason: "container_exited" });
    expect(r.pm2).toBe("online");
  });

  it("a container that listens but crash-loops is not healthy", () => {
    const r = run(move(), { flags: ["ctr_listens", "crashloop"] });
    expect(r.outcome).toMatchObject({ result: "rolled_back", reason: "container_exited" });
  });

  it("pm2 delete fails after a healthy start: the move stands, the leftover entry is reported", () => {
    const r = run(move(), { flags: ["ctr_listens", "delete_fail"] });
    expect(r.outcome).toMatchObject({ result: "moved_pm2_left", reason: "delete_failed" });
    expect(r.ctr).toBe("running");
  });

  it("the rollback itself cannot restart PM2: said loudly, never a silent success", () => {
    const r = run(move(), { flags: ["run_fail", "start_fail"] });
    expect(r.outcome).toMatchObject({ result: "rollback_failed", reason: "start_failed" });
    expect(r.pm2).toBe("stopped");
  });

  it("another move of the same app holds the lock: refused before anything is touched", () => {
    const r = run(move(), { flags: ["lock_held"] });
    expect(r.outcome).toMatchObject({ result: "aborted", reason: "busy" });
    expect(r.events.filter((e) => e.startsWith("pm2:") || e.startsWith("docker:"))).toEqual([]);
    expect(r.pm2).toBe("online");
  });
  it("takes the per-app lock (non-blocking) before the first step", () => {
    const r = run(move(), { flags: ["ctr_listens"] });
    expect(r.events[0]).toBe("flock -n 9");
    expect(existsSync(join(dir, "lock", "pm2move-cmapp1.lock"))).toBe(true);
  });
  it("exactly one final marker per run", () => {
    const r = run(move(), { flags: ["ctr_listens"] });
    expect(r.out.match(/TUGRA_PM2MOVE: result=/g)).toHaveLength(1);
  });
});

describe("the recovery script (outcome unknown)", () => {
  const rec = () => buildPm2RecoverScript(BASE);
  it("is valid bash", () => {
    expect(spawnSync("bash", ["-n", "-c", rec()], { encoding: "utf8" }).status).toBe(0);
  });
  it("PM2 is serving: nothing to restore, a stray container is removed", () => {
    const r = run(rec(), { pm2: "online", ctr: "running" });
    expect(r.outcome).toMatchObject({ result: "rolled_back", reason: "recovered" });
    expect(r.ctr).toBe("absent");
  });
  it("the process is stopped in PM2: put back (container removed, pm2 start)", () => {
    const r = run(rec(), { pm2: "stopped", ctr: "exited" });
    expect(r.outcome.result).toBe("rolled_back");
    expect(r.pm2).toBe("online");
    expect(r.ctr).toBe("absent");
  });
  it("the process is gone from PM2 and the container runs: the move had finished; the live container is kept", () => {
    const r = run(rec(), { pm2: "gone", ctr: "running" });
    expect(r.outcome).toMatchObject({ result: "moved", reason: "recovered" });
    expect(r.ctr).toBe("running");
  });
  it("gone from PM2 and no container: reported as failed, not hidden", () => {
    const r = run(rec(), { pm2: "gone" });
    expect(r.outcome).toMatchObject({ result: "rollback_failed", reason: "gone" });
  });
  it("waits for a move that may still be alive; when the lock never frees, it touches nothing and says nothing final", () => {
    const held = run(rec(), { pm2: "stopped", ctr: "running", flags: ["lock_held"] });
    expect(held.events).toEqual(["flock -w 150 9"]);
    expect(held.outcome.result).toBe("unknown"); // the hub keeps the record and reports it as unknown
    expect(held.pm2).toBe("stopped");
    expect(held.ctr).toBe("running");
    const free = run(rec(), { pm2: "stopped", ctr: "exited" });
    expect(free.events[0]).toBe("flock -w 150 9");
    expect(free.outcome.result).toBe("rolled_back");
  });
  it("host helper unavailable: reported", () => {
    const r = run(rec(), { flags: ["host_down"] });
    expect(r.outcome.result).toBe("rollback_failed");
  });
});

describe("the host-side PM2 script (POSIX sh, run through nsenter on the host)", () => {
  let h: string;
  let hbin: string;
  const FAKE_ID = `#!/bin/sh\n[ "$1" = "-u" ] && { echo "$FAKE_UID"; exit 0; }\nexit 1\n`;
  const FAKE_TIMEOUT = `#!/bin/sh\nshift\nexec "$@"\n`;
  // runuser -u <user> -- cmd...
  const FAKE_RUNUSER = `#!/bin/sh\necho "runuser:$2" >> "$H_LOG"\nshift 3\nexec "$@"\n`;
  const FAKE_PM2 = `#!/bin/sh
echo "pm2:$*" >> "$H_LOG"
s=$(cat "$H_STATE" 2>/dev/null)
case "$1" in
  pid) [ "$s" = online ] && echo 777 || echo 0;;
  jlist) if [ "$s" = gone ]; then echo '[]'; else echo '[{"name":"other","pid":1},{"name":"my app","pid":777,"pm2_env":{"name":"my app"}}]'; fi;;
  stop) echo stopped > "$H_STATE";;
  restart) echo online > "$H_STATE";;
  delete) echo gone > "$H_STATE";;
  save) [ -e "$H_NOFORCE" ] && [ "$2" = "--force" ] && exit 1; echo saved >> "$H_LOG";;
esac
exit 0
`;
  const install = (name: string, body: string, d = hbin) => {
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, name), body);
    chmodSync(join(d, name), 0o755);
  };
  const sh = (op: Parameters<typeof hostPm2Inner>[0], over: Partial<Pm2ScriptInput> = {}, env: Record<string, string> = {}) => {
    const input = { ...BASE, home: h, ...over };
    const r = spawnSync(process.env.PM2_TEST_SH ?? "/bin/sh", ["-c", hostPm2Inner(op, input)], {
      env: { PATH: `${hbin}:/usr/bin:/bin`, H_LOG: join(h, "log"), H_STATE: join(h, "state"), FAKE_UID: "1001", ...env },
      encoding: "utf8",
    });
    return { code: r.status, out: r.stdout, log: existsSync(join(h, "log")) ? readFileSync(join(h, "log"), "utf8") : "" };
  };
  beforeEach(() => {
    h = mkdtempSync(join(tmpdir(), "pm2host-"));
    hbin = join(h, "hbin");
    mkdirSync(join(h, ".pm2"), { recursive: true });
    writeFileSync(join(h, "state"), "online");
    install("id", FAKE_ID);
    install("timeout", FAKE_TIMEOUT);
    install("runuser", FAKE_RUNUSER);
    install("pm2", FAKE_PM2, join(h, ".nvm/versions/node/v18.0.0/bin"));
    install("pm2", FAKE_PM2, join(h, ".nvm/versions/node/v20.11.1/bin"));
  });
  afterEach(() => rmSync(h, { recursive: true, force: true }));

  it("pid: reports one live pid and that the process exists", () => {
    const r = sh("pid");
    expect(r.out).toContain("TUGRA_PM2_PID=777");
    expect(r.out).toContain("TUGRA_PM2_EXISTS=1");
  });
  it("runs pm2 as the account (runuser) with the process name as ONE argument", () => {
    const r = sh("stop");
    expect(r.out).toContain("TUGRA_PM2_STOPPED=1");
    expect(r.log).toContain("runuser:acme");
    expect(r.log).toContain("pm2:stop my app");
  });
  it("start restarts a stopped process; delete removes it and saves", () => {
    writeFileSync(join(h, "state"), "stopped");
    expect(sh("start").out).toContain("TUGRA_PM2_STARTED=1");
    const d = sh("delete");
    expect(d.out).toContain("TUGRA_PM2_DELETED=1");
    expect(d.out).toContain("TUGRA_PM2_SAVED=1");
    expect(d.log).toContain("pm2:save --force");
  });
  it("an old pm2 without `save --force` falls back to plain save", () => {
    const r = sh("delete", {}, { H_NOFORCE: join(h, "state") });
    expect(r.out).toContain("TUGRA_PM2_SAVED=1");
    expect(r.log).toContain("pm2:save");
  });
  it("root runs pm2 directly, without runuser", () => {
    const r = sh("pid", { user: "root", home: h, userUid: 0 }, { FAKE_UID: "0" });
    expect(r.out).toContain("TUGRA_PM2_PID=777");
    expect(r.log).not.toContain("runuser");
  });
  it("prefers the pm2 next to the interpreter PM2 ran with; else the newest nvm one", () => {
    install("pm2", `#!/bin/sh\necho "hint-pm2:$*" >> "$H_LOG"\ncase "$1" in pid) echo 5;; describe) exit 0;; esac\n`, join(h, "hint"));
    expect(sh("pid", { interpreterDir: join(h, "hint") }).log).toContain("hint-pm2:");
    expect(sh("pid").log).toContain("pm2:pid my app"); // the nvm one (v20 sorts after v18)
  });
  it("another account's uid is refused before anything runs", () => {
    const r = sh("stop", {}, { FAKE_UID: "1002" });
    expect(r.code).toBe(21);
    expect(r.out).toContain("TUGRA_PM2_ERR=user");
    expect(r.log).toBe("");
  });
  it("no pm2 binary, or no PM2 home, is reported", () => {
    rmSync(join(h, ".nvm"), { recursive: true });
    expect(sh("pid").out).toContain("TUGRA_PM2_ERR=nobin");
    rmSync(join(h, ".pm2"), { recursive: true });
    expect(sh("pid").out).toContain("TUGRA_PM2_ERR=nohome");
  });
  it("existence is read from the process list: a similar name does not count", () => {
    const r = sh("pid", { name: "my" });
    expect(r.out).toContain("TUGRA_PM2_EXISTS=0"); // "my app" and "other" exist, "my" does not
  });
  it("a process that is gone is not reported as running", () => {
    writeFileSync(join(h, "state"), "gone");
    const r = sh("pid");
    expect(r.out).toContain("TUGRA_PM2_PID=0");
    expect(r.out).toContain("TUGRA_PM2_EXISTS=0");
  });
  it("is plain POSIX sh (dash)", () => {
    if (!existsSync("/bin/dash")) return;
    const r = spawnSync("/bin/dash", ["-n", "-c", hostPm2Inner("delete", { ...BASE, home: h })], { encoding: "utf8" });
    expect(r.status).toBe(0);
  });
});
