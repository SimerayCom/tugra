// Self-test of the migration lab harness: the parts of scripts/lab whose logic can be checked WITHOUT docker, a hub or a
// database (node --test scripts/lab/selftest.mjs). The scenarios themselves only run on a docker host (the vx-lab workflow);
// this file pins every decision the harness makes about their results, so a harness bug cannot pass or fail a scenario for the
// wrong reason. Tests that need GNU coreutils or GNU tar skip (with the reason) where they are missing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, utimesSync, lutimesSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { select } from "./scope.mjs";
import { parseDockerSize } from "./units.mjs";
import { resolveDbMode } from "./seed-mode.mjs";
import { buildFleet, route, summary, tokenOf, TEAMS, VERSION } from "./coolify-fleet.mjs";

const LAB = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(LAB, "../..");
const read = (f) => readFileSync(join(LAB, f), "utf8");
const tmp = () => mkdtempSync(join(tmpdir(), "labtest-"));
const CLEAN_ENV = { PATH: process.env.PATH, HOME: process.env.HOME };

function bash(script, env = {}) {
  return spawnSync("bash", ["-c", script], { env: { ...CLEAN_ENV, ...env }, encoding: "utf8" });
}
const has = (cmd, args = ["--version"]) => spawnSync(cmd, args, { encoding: "utf8" }).status === 0;

// ---- the workflow: `items` selects whole list entries, never substrings ----------------------------------------------------
test("workflow: items=restart does not also schedule the tar job", () => {
  const yml = readFileSync(join(ROOT, ".github/workflows/vx-lab.yml"), "utf8");
  const jobs = [...yml.matchAll(/^  ([a-z]+):\n(?:    [^\n]*\n)*?    if: ([^\n]+)\n/gm)].map((m) => ({ key: m[1], cond: m[2] }));
  assert.deepEqual(jobs.map((j) => j.key), ["tar", "core", "restart", "postgres", "memory", "seats", "throttle", "fleetpg", "fleetdb", "fleetminio", "fleethosts", "fleetcoolify", "ubuntu"]);
  for (const j of jobs) assert.equal(j.cond, `needs.plan.outputs.${j.key} == 'true'`, `job ${j.key} must be gated by the plan job`);
  // run the plan job's own script, exactly as written in the workflow
  const block = /      - id: pick\n[\s\S]*?        run: \|\n((?:          [^\n]*\n)+)/.exec(yml);
  assert.ok(block, "plan job pick step not found");
  const script = block[1].replace(/^          /gm, "");
  const selected = (items, event = "workflow_dispatch") => {
    const out = join(tmp(), "out");
    writeFileSync(out, "");
    const r = bash(script, { ITEMS: items, EVENT: event, GITHUB_OUTPUT: out });
    assert.equal(r.status, 0, r.stderr);
    const flags = Object.fromEntries(readFileSync(out, "utf8").trim().split("\n").map((l) => l.split("=")));
    return jobs.map((j) => j.key).filter((k) => flags[k] === "true");
  };
  assert.deepEqual(selected("restart"), ["restart"]);
  assert.deepEqual(selected("core, tar"), ["tar", "core"]);
  assert.deepEqual(selected("all").length, 13);
  assert.deepEqual(selected("", "schedule").length, 13);
  // the fleet-shaped items: by name, as a group, and never by substring
  assert.deepEqual(selected("fleetpg"), ["fleetpg"]);
  assert.deepEqual(selected("fleet"), ["fleetpg", "fleetdb", "fleetminio", "fleethosts", "fleetcoolify", "ubuntu"]);
  assert.deepEqual(selected("tar,fleet,seats"), ["tar", "seats", "fleetpg", "fleetdb", "fleetminio", "fleethosts", "fleetcoolify", "ubuntu"]);
  assert.deepEqual(selected("postgres"), ["postgres"], "postgres must not also select fleetpg");
  assert.deepEqual(selected("fleetdb, ubuntu"), ["fleetdb", "ubuntu"]);
});

test("workflow: the matrices and inputs the fleet scenarios read", () => {
  const yml = readFileSync(join(ROOT, ".github/workflows/vx-lab.yml"), "utf8");
  const section = (key) => new RegExp(`^  ${key}:\n[\\s\\S]*?(?=^  [a-z]+:\n|(?![\\s\\S]))`, "m").exec(yml)?.[0] ?? "";
  // L6: the four images of the real estate
  for (const img of ["postgres:16-alpine", "postgres:17-alpine", "pgvector/pgvector:pg17", "postgres:18-alpine"]) assert.ok(section("postgres").includes(`- ${img}`), `L6 matrix lacks ${img}`);
  // L9: the physical path (17) and the layout refusal (18)
  assert.ok(section("fleetpg").includes("- postgres:17-alpine") && section("fleetpg").includes("- postgres:18-alpine"));
  assert.match(section("fleetpg"), /L9_GIB: \$\{\{ inputs\.pg_gib \|\| '4' \}\}/);
  assert.match(section("fleetminio"), /FLEET_MINIO_DIV: \$\{\{ inputs\.minio_div \|\| '4' \}\}/);
  // L8: two migrators on one seat, and the fleet shape, four on two (more migrators than seats, or no migrator is ever busy)
  const seats = section("seats");
  assert.match(seats, /migrators: 2\n\s+seats: 1/);
  assert.match(seats, /migrators: 4\n\s+seats: 2/);
  assert.match(seats, /L8_MIGRATORS: \$\{\{ matrix\.migrators \}\}/);
  assert.match(seats, /L8_SEATS: \$\{\{ matrix\.seats \}\}/);
  // every fleet job runs its own script
  for (const [key, script] of [["fleetpg", "l9-fleet-pg.sh"], ["fleetdb", "l10-fleet-mariadb.sh"], ["fleetminio", "l11-fleet-minio.sh"], ["fleethosts", "l12-fleet-hosts.sh"], ["fleetcoolify", "l13-fleet-coolify.sh"], ["ubuntu", "l14-ubuntu-source.sh"]]) {
    assert.ok(section(key).includes(`scripts/lab/${script}`), `${key} must run ${script}`);
    assert.ok(existsSync(join(LAB, script)), `${script} is missing`);
    assert.ok(section(key).includes("scripts/lab/down.sh"), `${key} must tear the lab down`);
  }
});

// ---- the destructive guard ---------------------------------------------------------------------------------------------------
test("guard: the lab refuses to run unless the host is disposable", () => {
  const lib = join(LAB, "lib.sh");
  const dir = tmp();
  const run = (env) => bash(`. ${lib}; lab_guard_destructive`, { LAB_DIR: dir, ...env });
  assert.notEqual(run({}).status, 0);
  assert.match(run({}).stderr, /refusing to run/);
  assert.equal(run({ CI: "true" }).status, 0);
  assert.equal(run({ LAB_I_UNDERSTAND_DESTRUCTIVE: "1" }).status, 0);
  assert.notEqual(run({ CI: "false" }).status, 0);
});

test("guard: down.sh refuses before touching anything and keeps LAB_DIR", () => {
  const dir = tmp();
  writeFileSync(join(dir, "marker"), "x");
  const r = bash(`bash ${join(LAB, "down.sh")}`, { LAB_DIR: dir });
  assert.notEqual(r.status, 0);
  assert.ok(existsSync(join(dir, "marker")), "down.sh removed LAB_DIR although it refused");
});

test("guard: a scenario start is guarded too", () => {
  assert.match(read("lib.sh"), /lab_scenario_begin\(\) \{\n  local name="\$1"; shift\n  lab_guard_destructive\n/);
  assert.match(read("up.sh"), /\nlab_guard_destructive\n/);
});

// ---- what the lab owns --------------------------------------------------------------------------------------------------------
test("scope: only volumes and dirs of ids in the lab database are lab-owned", () => {
  const lines = [
    "app A1", "db D1", "transfer T1", "move M1",
    "volume tugra_appv_A1_data", "volume tugra_appv_A10_data", "volume tugra_appv_REAL_data",
    "volume tugra_dbv_D1", "volume tugra_dbv_D10", "volume tugra_dbv_REAL",
    "volume tugra_restore_rb_vxT1", "volume tugra_restore_rb_vxREAL", "volume tugra_vx_real",
    "volume lab-src", "volume lab-agent-state", "volume labrador", "volume my-lab-src",
    "dir T1", "dir M1", "dir REAL",
  ];
  assert.deepEqual(select("volumes", lines), ["tugra_appv_A1_data", "tugra_dbv_D1", "tugra_restore_rb_vxT1", "lab-src", "lab-agent-state"]);
  assert.deepEqual(select("dirs", lines), ["T1", "M1"]);
  assert.deepEqual(select("volumes", ["volume tugra_appv_X_data", "volume lab-src"]), ["lab-src"], "no ids known: only the fixed lab names");
});

// ---- L0: the unchanged-host snapshot ---------------------------------------------------------------------------------------
test("L0: the docker snapshot ignores docker's relative Status text", () => {
  const bin = tmp();
  const counter = join(bin, "n");
  writeFileSync(join(bin, "docker"), `#!/bin/bash
fmt=""; while [ $# -gt 0 ]; do [ "$1" = --format ] && fmt="$2"; shift; done
n=$(cat "${counter}" 2>/dev/null || echo 0); echo $((n+1)) > "${counter}"
for name in lab-agent lab-registry tugra-migrator-ab12; do
  l="$fmt"; l="\${l//\\{\\{.Names\\}\\}/$name}"; l="\${l//\\{\\{.ID\\}\\}/id-$name}"; l="\${l//\\{\\{.State\\}\\}/running}"; l="\${l//\\{\\{.Status\\}\\}/Up $n seconds}"; echo "$l"
done
`);
  chmodSync(join(bin, "docker"), 0o755);
  const lib = join(LAB, "lib.sh");
  const r = bash(`. ${lib}; a="$(lab_docker_snapshot)"; b="$(lab_docker_snapshot)"; [ "$a" = "$b" ] && echo "$a"`, { LAB_DIR: tmp(), PATH: `${bin}:${process.env.PATH}` });
  assert.equal(r.status, 0, `two reads of an untouched host differ: ${r.stderr}`);
  assert.match(r.stdout, /lab-agent id-lab-agent running/);
  assert.doesNotMatch(r.stdout, /tugra-migrator/);
  assert.doesNotMatch(read("l0-dry-run.sh"), /\.Status/);
  assert.match(read("l0-dry-run.sh"), /lab_docker_snapshot/);
});

// ---- the manifest and the tar listing behind compare.sh's DIR-MTIME-ONLY verdict ---------------------------------------------
function gnuShim() {
  // manifest.sh runs in busybox/GNU on the lab host; locally, GNU stat and sha256sum may only exist under a g-prefix
  const bin = tmp();
  for (const [name, alt] of [["stat", "gstat"], ["sha256sum", "gsha256sum"]]) {
    const probe = name === "stat" ? ["-c", "%a", "."] : ["--version"];
    if (has(name, probe)) continue;
    const w = spawnSync("which", [alt], { encoding: "utf8" });
    if (w.status !== 0) return null;
    symlinkSync(w.stdout.trim(), join(bin, name));
  }
  return bin;
}
function tree() {
  const d = tmp();
  chmodSync(d, 0o750);
  mkdirSync(join(d, "sub"));
  writeFileSync(join(d, "f"), "hello");
  chmodSync(join(d, "f"), 0o755);
  writeFileSync(join(d, "suid"), "x");
  chmodSync(join(d, "suid"), 0o4755);
  symlinkSync("f", join(d, "link"));
  const t = new Date("2023-01-15T10:30:45Z");
  for (const p of ["f", "suid", "sub"]) utimesSync(join(d, p), t, t);
  lutimesSync(join(d, "link"), t, t);
  spawnSync("mkfifo", [join(d, "fifo")]);
  return d;
}
function manifest(dir, shim, extra = {}) {
  return execFileSync("sh", [join(LAB, "manifest.sh")], { env: { PATH: `${shim}:${process.env.PATH}`, DATA: dir, ...extra }, encoding: "utf8" });
}

test("manifest: the volume root, the setuid digit and symlink/FIFO mtimes are compared", (t) => {
  const shim = gnuShim();
  if (!shim) return t.skip("GNU stat and sha256sum are not available here");
  const d = tree();
  const base = manifest(d, shim);
  assert.match(base, /^\.\|directory\|/m, "the volume root is an entry");
  assert.match(base, /^\.\/suid\|regular file\|[0-9:]+\|4755\|/m, "the setuid digit is kept");
  chmodSync(join(d, "suid"), 0o755);
  assert.notEqual(manifest(d, shim), base, "a lost setuid bit must change the manifest");
  chmodSync(join(d, "suid"), 0o4755);
  assert.equal(manifest(d, shim), base);
  chmodSync(d, 0o700);
  assert.notEqual(manifest(d, shim), base, "a different root mode must change the manifest");
  chmodSync(d, 0o750);
  lutimesSync(join(d, "link"), new Date("2024-02-02T00:00:00Z"), new Date("2024-02-02T00:00:00Z"));
  assert.notEqual(manifest(d, shim), base, "a symlink mtime must change the manifest");
  lutimesSync(join(d, "link"), new Date("2023-01-15T10:30:45Z"), new Date("2023-01-15T10:30:45Z"));
  spawnSync("touch", ["-t", "202401010101", join(d, "fifo")]);
  assert.notEqual(manifest(d, shim), base, "a FIFO mtime must change the manifest");
  // directory mtimes stay out of the default manifest (reported separately)
  const again = tree();
  assert.equal(manifest(again, shim).split("\n").filter((l) => l.startsWith("./sub|")).length, 1);
});

test("tarlist: only DIRECTORY mtimes are masked", (t) => {
  const gtar = has("gtar") ? "gtar" : has("tar") && /GNU tar/.test(spawnSync("tar", ["--version"], { encoding: "utf8" }).stdout) ? "tar" : null;
  if (!gtar) return t.skip("GNU tar is not available here");
  const list = (dir) => execFileSync("sh", [join(LAB, "tarlist.sh")], { env: { PATH: process.env.PATH, DATA: dir, TAR: gtar }, encoding: "utf8" });
  const d = tree();
  const base = list(d);
  assert.match(base, /^drwx[^ ]+ \d+\/\d+ +0 MASKED \.\/$/m, "the root entry is listed, its mtime masked");
  // a directory mtime alone is the one accepted difference
  utimesSync(join(d, "sub"), new Date("2020-05-05T05:05:05Z"), new Date("2020-05-05T05:05:05Z"));
  utimesSync(d, new Date("2020-05-05T05:05:05Z"), new Date("2020-05-05T05:05:05Z"));
  assert.equal(list(d), base);
  // everything else is a real difference
  chmodSync(d, 0o700);
  assert.notEqual(list(d), base, "root mode");
  chmodSync(d, 0o750);
  chmodSync(join(d, "suid"), 0o755);
  assert.notEqual(list(d), base, "setuid bit");
  chmodSync(join(d, "suid"), 0o4755);
  lutimesSync(join(d, "link"), new Date("2024-02-02T00:00:00Z"), new Date("2024-02-02T00:00:00Z"));
  assert.notEqual(list(d), base, "symlink mtime");
  lutimesSync(join(d, "link"), new Date("2023-01-15T10:30:45Z"), new Date("2023-01-15T10:30:45Z"));
  assert.equal(list(d), base);
  spawnSync("touch", ["-t", "202401010101", join(d, "fifo")]);
  assert.notEqual(list(d), base, "FIFO mtime");
  assert.match(read("compare.sh"), /listing "\$SRC"/, "compare.sh decides DIR-MTIME-ONLY from the tar listing");
});

// ---- the HTTP tap -------------------------------------------------------------------------------------------------------------

// a tap with a barrier in front of a stub hub; calls return {status, body, at} so the order of answers can be checked
async function barrierTap(extra) {
  const hub = http.createServer((req, res) => { req.resume(); req.on("end", () => res.end(JSON.stringify({ path: req.url }))); });
  await new Promise((r) => hub.listen(0, "127.0.0.1", r));
  const dir = tmp();
  const busyFile = join(dir, "busy"), barrierFile = join(dir, "barrier");
  writeFileSync(busyFile, ""); writeFileSync(barrierFile, "");
  const port = 43000 + Math.floor(Math.random() * 2000);
  const tap = spawn("node", [join(LAB, "http-tap.mjs"), "--listen", String(port), "--target", `127.0.0.1:${hub.address().port}`, "--busy-file", busyFile, "--host", "127.0.0.1", "--barrier-file", barrierFile, ...extra], { stdio: "ignore" });
  const call = (path, token) => new Promise((resolveP, rejectP) => {
    const r = http.request({ host: "127.0.0.1", port, path, method: "GET", headers: token ? { authorization: `Bearer ${token}` } : {} }, (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolveP({ status: res.statusCode, body: b, at: Date.now() })); });
    r.on("error", rejectP);
    r.end();
  });
  for (let i = 0; i < 50; i++) { try { await call("/health"); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  return { call, barrierFile, stop: () => { tap.kill(); hub.close(); } };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("http-tap barrier: no migrator's `targets` is answered until N different tokens asked, then all at once", async () => {
  const t = await barrierTap(["--barrier", "3"]);
  try {
    const answered = [];
    const asked = (tok) => t.call("/api/v1/migrator/targets", tok).then((r) => { answered.push(tok); return r; });
    const a = asked("a");
    const a2 = asked("a"); // the same token twice is still ONE migrator
    await sleep(300);
    assert.deepEqual(answered, [], "held while only one token asked");
    assert.equal((await t.call("/api/v1/other", "a")).status, 200, "anything but `targets` is never held");
    const b = asked("b");
    await sleep(300);
    assert.deepEqual(answered, [], "held with two of three tokens");
    const c = asked("c");
    const all = await Promise.all([a, a2, b, c]);
    assert.ok(all.every((r) => r.status === 200 && JSON.parse(r.body).path.endsWith("/targets")));
    assert.equal(readFileSync(t.barrierFile, "utf8"), "released all 3\n");
    const late = Date.now();
    assert.ok((await asked("a")).at - late < 500, "after the release `targets` passes straight through");
  } finally { t.stop(); }
});

test("http-tap barrier: a group that never completes is released by the timeout and the file says so", async () => {
  const t = await barrierTap(["--barrier", "2", "--barrier-timeout", "1"]);
  try {
    const t0 = Date.now();
    const r = await t.call("/api/v1/migrator/targets", "only");
    assert.equal(r.status, 200);
    assert.ok(r.at - t0 >= 900, "held for the timeout");
    assert.equal(readFileSync(t.barrierFile, "utf8"), "released timeout 1/2\n");
  } finally { t.stop(); }
});

test("http-tap barrier: a barrier needs its proof file, and a plain tap has none", () => {
  const bad = spawnSync("node", [join(LAB, "http-tap.mjs"), "--listen", "1", "--target", "127.0.0.1:1", "--busy-file", "/dev/null", "--barrier", "2"], { encoding: "utf8" });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /bad --barrier/);
  assert.match(read("lib.sh"), /LAB_TAP_BARRIER/);
});
test("http-tap counts the hub's busy answers to part registrations and nothing else", async () => {
  let n = 0;
  const hub = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.method === "POST" && /\/parts\/\d+$/.test(req.url)) { n += 1; res.end(JSON.stringify(n === 2 ? { srcPath: "/x" } : { busy: true })); }
      else res.end(JSON.stringify({ busy: true, other: req.url })); // not a registration: never counted
    });
  });
  await new Promise((r) => hub.listen(0, "127.0.0.1", r));
  const dir = tmp();
  const busyFile = join(dir, "busy");
  writeFileSync(busyFile, "");
  const port = 41000 + Math.floor(Math.random() * 2000);
  const tap = spawn("node", [join(LAB, "http-tap.mjs"), "--listen", String(port), "--target", `127.0.0.1:${hub.address().port}`, "--busy-file", busyFile, "--host", "127.0.0.1"], { stdio: "ignore" });
  try {
    const call = (method, path) => new Promise((resolveP, rejectP) => {
      const r = http.request({ host: "127.0.0.1", port, path, method }, (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolveP(JSON.parse(b))); });
      r.on("error", rejectP);
      r.end();
    });
    for (let i = 0; i < 50; i++) { try { await call("GET", "/health"); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    const lines = () => readFileSync(busyFile, "utf8").split("\n").filter(Boolean).length;
    assert.deepEqual(await call("POST", "/api/v1/import/operations/o/volumes/v/parts/0"), { busy: true }); // counted
    assert.deepEqual(await call("POST", "/api/v1/import/operations/o/volumes/v/parts/1"), { srcPath: "/x" }); // not busy
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(lines(), 1);
    assert.equal((await call("GET", "/api/v1/other")).other, "/api/v1/other"); // passes through untouched
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(lines(), 1);
  } finally {
    tap.kill();
    hub.close();
  }
});

// ---- scenario timing and ordering, read from the scripts (they cannot run without docker) ------------------------------------
const num = (s, re) => Number(re.exec(s)?.[1]);

test("L3: the boundary part runs with a stale window longer than its whole transfer", () => {
  const s = read("l3-throttle.sh");
  const stale = num(s, /hub\.sh" restart [^\n]*MIGRATION_VX_STALE_MS=(\d+)/);
  assert.ok(stale > 0, "the boundary restart must set MIGRATION_VX_STALE_MS");
  const mib = num(s, /fixture\.sh" "\$SRC_VOLUME" (\d+) random   # one part/);
  const rate = num(s, /lab_proxy_start (0\.25)\n  lab_run boundary/);
  const partSeconds = (mib * 1048576) / (rate * 1e6);
  assert.ok(partSeconds > 100 && partSeconds < 140, `part time ${partSeconds}`);
  assert.ok(stale >= 3 * partSeconds * 1000, `stale window ${stale} ms must be well above the ${Math.round(partSeconds)} s part`);
});

test("L2-A: the hub outage fits inside the stale window", () => {
  const s = read("l2-hub-restart.sh");
  const stale = num(s, /hub\.sh" restart MIGRATION_VX_PART_MIB=32 MIGRATION_VX_STALE_MS=(\d+)/);
  const outage = num(s, /hub\.sh" kill\nsleep (\d+)/);
  assert.ok(stale > 0 && outage > 0);
  assert.ok(stale >= (outage + 16 + 90) * 1000, `stale window ${stale} ms vs a ${outage} s outage + a 16 s part + boot`);
  assert.match(read("up.sh"), /MIGRATION_VX_STALE_MS=30000/, "the 30 s default stays for the L1b lease cases");
});

test("L6: the database is not provisioned a second time and WAL evidence is read from the hub-started container", () => {
  const s = read("l6-postgres.sh");
  assert.doesNotMatch(s, /POST "\/databases\/\$DB_ID\/provision"/);
  assert.doesNotMatch(s, /COMPARE_EXCLUDE=postmaster\.pid lab_compare/, "the destination belongs to a running server by then");
  assert.ok(s.indexOf("WAL replay ran on the copied cluster") > s.indexOf("lab_wait 180"), "the log check follows the wait for RUNNING");
});

test("L8: every migrator is started together behind the tap's barrier, never staggered, and the tap proves contention", () => {
  const s = read("l8-relay-seats.sh");
  const m1 = s.indexOf("lab_run_bg m1");
  const m2 = s.indexOf("lab_run_bg m2");
  const released = s.indexOf('grep -q "^released all $N');
  assert.ok(m1 > 0 && m2 > m1 && released > m2, "m1, m2 (and later m3, m4), then the proof that they all lined up");
  assert.doesNotMatch(s.slice(m1, released), /lab_wait_part/, "no migrator waits for another to commit a part: reapStaleHelpers would remove its live helpers");
  assert.match(s, /LAB_TAP_BARRIER="\$N" lab_tap_start/);
  assert.match(s, /lab_run_bg m1 --hub "\$LAB_TAP_URL"/);
  assert.match(s, /lab_run_bg m2 --hub "\$LAB_TAP_URL"/);
  assert.match(s, /lab_check "the migration seat pool was contended/);
  assert.match(s, /run-scoped/, "the header names the product finding");
  assert.doesNotMatch(s, /two starting together would delete each other/, "the old, wrong premise is gone");
  assert.match(s, /probably another migrator on this docker host removed its helper container/, "a helper failure is reported as finding 2, not as a seat problem");
});


// ---- every lab script parses; nothing real is written into the lab -----------------------------------------------------------
test("every script under scripts/lab parses with bash -n", () => {
  const { readdirSync } = require_fs();
  for (const f of readdirSync(LAB).filter((n) => n.endsWith(".sh"))) {
    const r = spawnSync("bash", ["-n", join(LAB, f)], { encoding: "utf8" });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
});

function require_fs() { return { readdirSync: (d) => execFileSync("ls", [d], { encoding: "utf8" }).split("\n").filter(Boolean) }; }

test("no real address is written into the lab, its runbook or its workflow", () => {
  // the only addresses allowed: loopback, the any-address, the TEST-NET-1 documentation range (the mock Coolify's servers), the default
  // docker bridge and RFC1918 10.0.0.x examples. A real host or customer address must never be pasted into a fixture, test or doc.
  const allowed = /^(127\.|0\.0\.0\.0$|192\.0\.2\.|172\.17\.|10\.0\.0\.)/;
  const files = [...execFileSync("ls", [LAB], { encoding: "utf8" }).split("\n").filter(Boolean).map((f) => join(LAB, f)), join(ROOT, "docs/runbooks/migration-lab.md"), join(ROOT, ".github/workflows/vx-lab.yml")];
  const bad = [];
  for (const f of files) {
    if (f.endsWith("selftest.mjs")) continue;
    for (const m of readFileSync(f, "utf8").matchAll(/(?<![\d.])(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?![\d.])/g)) {
      if (!allowed.test(m[1])) bad.push(`${f}: ${m[1]}`);
    }
  }
  assert.deepEqual(bad, []);
});

// ---- units, seed modes ------------------------------------------------------------------------------------------------------
test("units: docker's decimal human sizes", () => {
  assert.equal(parseDockerSize("0B"), 0);
  assert.equal(parseDockerSize("654kB"), 654000);
  assert.equal(parseDockerSize("12.5MB"), 12500000);
  assert.equal(parseDockerSize("2.147GB"), 2147000000);
  assert.equal(parseDockerSize("1TB"), 1e12);
  assert.throws(() => parseDockerSize("N/A"));
  assert.throws(() => parseDockerSize("12 parsecs"));
  const r = spawnSync("node", [join(LAB, "units.mjs"), "parse", "1.5GB"], { encoding: "utf8" });
  assert.equal(r.stdout.trim(), "1500000000");
});

test("seed: PostgreSQL stays a physical copy by default, every other engine is logical only", () => {
  assert.deepEqual(resolveDbMode("db", "POSTGRES", ""), { engine: "POSTGRES", mode: "volume" });
  assert.deepEqual(resolveDbMode("db", "POSTGRES", "dump"), { engine: "POSTGRES", mode: "dump" });
  assert.deepEqual(resolveDbMode("db", "MARIADB", ""), { engine: "MARIADB", mode: "dump" });
  assert.deepEqual(resolveDbMode("db", "REDIS", "dump"), { engine: "REDIS", mode: "dump" });
  assert.deepEqual(resolveDbMode("app", "MARIADB", ""), { engine: "POSTGRES", mode: "volume" }, "an app op has no engine");
  assert.throws(() => resolveDbMode("db", "MARIADB", "volume"), /PostgreSQL only/);
  assert.throws(() => resolveDbMode("db", "MONGO", ""), /bad --engine/);
  assert.throws(() => resolveDbMode("db", "POSTGRES", "rsync"), /bad --data-mode/);
  const seed = read("seed.mjs");
  assert.match(seed, /kv\("ITEMREF", plan\.mode === "dump" \? ownerRef/, "a logical op reports the database ref");
  assert.match(seed, /proposed: plan\.mode === "volume" \? \{ dataMode: "volume" \}/, "only a physical op carries dataMode volume");
});

// ---- the fleet library --------------------------------------------------------------------------------------------------------
test("fleet.sh: Coolify-style names, image majors and mounts, the bucket plan", () => {
  const dir = tmp();
  const run = (cmd, env = {}) => bash(`. ${join(LAB, "fleet.sh")}; ${cmd}`, { LAB_DIR: dir, ...env });
  const u = run("fleet_uuid").stdout.trim();
  assert.match(u, /^[a-z][a-z0-9]{23}$/, "a 24 character resource name starting with a letter");
  assert.match(run("fleet_stamp").stdout.trim(), /^[0-9]{13}$/, "a 13 digit deploy stamp");
  const majors = run("for i in postgres:16-alpine postgres:17-alpine pgvector/pgvector:pg17 postgres:18-alpine; do fleet_pg_major $i; done").stdout.trim().split("\n");
  assert.deepEqual(majors, ["16", "17", "17", "18"]);
  const mounts = run("for i in postgres:16-alpine pgvector/pgvector:pg17 postgres:18-alpine; do fleet_pg_mount $i; done").stdout.trim().split("\n");
  assert.deepEqual(mounts, ["/var/lib/postgresql/data", "/var/lib/postgresql/data", "/var/lib/postgresql"], "18 keeps PGDATA one level down");
  // the bucket plan: 12 buckets, the real size classes at div 1, a fraction at the default
  const real = run("fleet_minio_plan", { FLEET_MINIO_DIV: "1" }).stdout.trim().split("\n").map((l) => l.split(" "));
  assert.equal(real.length, 12);
  assert.equal(real[0][1], "122", "3900 MiB is 122 objects of 32 MiB");
  const total = (div) => run("fleet_minio_plan", { FLEET_MINIO_DIV: div }).stdout.trim().split("\n").reduce((n, l) => n + Number(l.split(" ")[1]), 0);
  assert.ok(total("1") * 32 >= 8600 && total("1") * 32 <= 9300, `the real shape is about 8.8 GB, got ${total("1") * 32} MiB`);
  assert.ok(total("4") * 32 < total("1") * 32 / 3, "the default scales the shape down");
  assert.equal(run("fleet_minio_plan", { FLEET_MINIO_DIV: "100000" }).stdout.trim().split("\n").every((l) => l.endsWith(" 1")), true, "a bucket keeps at least one object");
});

test("fleet.sh: everything it creates is labelled, and cleanup only touches the label", () => {
  const f = read("fleet.sh");
  assert.match(f, /FLEET_LABEL:=tugra\.lab\.fleet=1/);
  assert.match(f, /fleet_run\(\) \{ docker run -d --label "\$FLEET_LABEL"/);
  assert.match(f, /fleet_volume\(\) \{ docker volume create --label "\$FLEET_LABEL"/);
  const cleanup = /fleet_cleanup\(\) \{[\s\S]*?\n\}/.exec(f)[0];
  assert.match(cleanup, /docker ps -aq --filter "label=\$FLEET_LABEL"/);
  assert.doesNotMatch(cleanup, /docker (ps|container ls) -aq\s*\)/, "no unfiltered container removal");
  assert.doesNotMatch(cleanup, /docker system prune|volume prune/);
  assert.match(read("down.sh"), /\nfleet_cleanup\n/);
});

test("fleet.sh: fleet_snapshot_others names every container but the excluded and the migrator's own", () => {
  const dir = tmp();
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "docker"), `#!/bin/sh\nif [ "$1" = ps ]; then printf 'aaa running\\nbbb exited\\ntugra-migrator-77 running\\nccc running\\n'; fi\n`);
  chmodSync(join(bin, "docker"), 0o755);
  const r = bash(`. ${join(LAB, "fleet.sh")}; fleet_snapshot_others bbb`, { LAB_DIR: dir, PATH: `${bin}:${process.env.PATH}` });
  assert.equal(r.stdout, "aaa running\nccc running\n");
  const all = bash(`. ${join(LAB, "fleet.sh")}; fleet_snapshot_others`, { LAB_DIR: dir, PATH: `${bin}:${process.env.PATH}` });
  assert.equal(all.stdout, "aaa running\nbbb exited\nccc running\n");
});

// ---- the Coolify 4.1.2 fleet --------------------------------------------------------------------------------------------------
test("coolify-fleet: the shape of the real estate, scoped by token, with an unfiltered /teams", () => {
  const fleet = buildFleet();
  assert.equal(fleet.version, VERSION);
  assert.equal(VERSION, "4.1.2");
  const sum = summary(fleet);
  assert.equal(sum.length, 8);
  const tot = (k) => sum.reduce((n, t) => n + t[k], 0);
  assert.deepEqual({ apps: tot("apps"), databases: tot("databases"), services: tot("services"), servers: tot("servers") }, { apps: 78, databases: 29, services: 19, servers: 24 });
  assert.deepEqual(sum.map((t) => t.apps), [30, 14, 19, 8, 0, 0, 3, 4]);
  assert.equal(sum.filter((t) => t.apps === 0).length, 2, "two empty teams");
  const all = fleet.teams.flatMap((t) => t.apps);
  assert.equal(all.filter((a) => a.build_pack === "dockerfile").length, 74);
  assert.equal(all.filter((a) => a.build_pack === "dockerimage").length, 3);
  assert.equal(all.filter((a) => a.build_pack === "nixpacks").length, 1);
  assert.equal(all.filter((a) => !a.fqdn).length, 7, "seven applications without a domain (workers)");
  assert.ok(all.every((a) => !a.fqdn || (a.fqdn.includes("https://") && a.fqdn.includes("http://") && a.fqdn.includes(","))), "a comma list with both schemes");
  const dbs = fleet.teams.flatMap((t) => t.databases);
  assert.deepEqual(["standalone-redis", "standalone-postgresql", "standalone-mariadb"].map((ty) => dbs.filter((d) => d.database_type === ty).length), [14, 10, 5]);
  const svcs = fleet.teams.flatMap((t) => t.services);
  assert.equal(svcs.filter((s) => s.service_type === "meilisearch").length, 7);
  assert.equal(svcs.filter((s) => s.service_type === "minio").length, 6);
  assert.ok(svcs.every((s) => /^https:\/\/[a-z0-9.-]+\.example\.test:8080$/.test(s.applications[0].fqdn)), "service sub-apps carry :8080");
  assert.equal(new Set([...all, ...dbs, ...svcs].map((r) => r.uuid)).size, 78 + 29 + 19, "unique resource ids");
  assert.ok([...all, ...dbs, ...svcs].every((r) => r.uuid.length === 24));

  const t0 = fleet.teams[0].token;
  const get = (path, token) => route(fleet, "GET", path, token);
  assert.equal(get("/api/v1/servers", "bogus").status, 401);
  assert.equal(get("/api/v1/teams", t0).body.length, 8, "/teams is unfiltered");
  assert.equal(get("/api/v1/teams", fleet.teams[4].token).body.length, 8);
  for (const t of fleet.teams) {
    assert.equal(get("/api/v1/applications", t.token).body.length, t.apps.length);
    assert.ok(get("/api/v1/applications", t.token).body.every((a) => a.name.startsWith(`t${t.id}-`)), "a token sees only its own team");
    assert.equal(get("/api/v1/servers", t.token).body.length, t.servers.length);
    const listed = t.servers.flatMap((s) => get(`/api/v1/servers/${s.uuid}/resources`, t.token).body);
    assert.equal(listed.length, t.apps.length + t.databases.length + t.services.length, "every resource sits on one of the team's servers");
  }
  const foreignApp = fleet.teams[1].apps[0].uuid;
  assert.equal(get(`/api/v1/applications/${foreignApp}`, t0).status, 404, "another team's resource is not readable");
  assert.equal(get(`/api/v1/applications/${foreignApp}/envs`, fleet.teams[1].token).status, 200);
  const envs = get(`/api/v1/applications/${foreignApp}/envs`, fleet.teams[1].token).body;
  assert.ok(envs.every((e) => e.value === undefined && e.real_value === undefined), "a read-only token sees no values");
  assert.ok(envs.some((e) => e.is_preview) && envs.some((e) => !e.is_preview), "preview twins are present");
  assert.equal(route(fleet, "POST", "/api/v1/applications", t0).status, 405);
  assert.equal(get("/api/v1/version", t0).text, "4.1.2");
  assert.equal(TEAMS.length, 8);
  assert.equal(tokenOf(3), fleet.teams[3].token);
  // two applications bind-mount a host path (the storages answer says so)
  const binds = fleet.teams.flatMap((t) => t.apps.map((a) => get(`/api/v1/applications/${a.uuid}/storages`, t.token).body.persistent_storages.filter((p) => p.host_path)).flat());
  assert.equal(binds.length, 2);
});

test("coolify-mock: serves the fleet over HTTP and refuses an unknown token", async () => {
  const child = spawn("node", [join(LAB, "coolify-mock.mjs"), "--listen", "0", "--bind", "127.0.0.1"], { stdio: ["ignore", "ignore", "pipe"] });
  try {
    const port = await new Promise((res, rej) => {
      child.stderr.on("data", (d) => { const m = /on 127\.0\.0\.1:(\d+)/.exec(String(d)); if (m) res(Number(m[1])); });
      child.on("exit", () => rej(new Error("mock exited")));
      setTimeout(() => rej(new Error("mock did not start")), 5000);
    });
    const get = (path, token) => new Promise((res, rej) => {
      http.get({ host: "127.0.0.1", port, path, headers: token ? { Authorization: `Bearer ${token}` } : {} }, (r) => {
        let b = ""; r.on("data", (c) => (b += c)); r.on("end", () => res({ status: r.statusCode, body: b }));
      }).on("error", rej);
    });
    const tok = tokenOf(0);
    assert.equal((await get("/api/v1/applications", "")).status, 401);
    const apps = await get("/api/v1/applications", tok);
    assert.equal(apps.status, 200);
    assert.equal(JSON.parse(apps.body).length, 30);
    assert.equal((await get("/api/v1/version", tok)).body, "4.1.2");
  } finally {
    child.kill();
  }
});

// ---- the scenarios' decisions ---------------------------------------------------------------------------------------------------
test("ubuntu-pick: the wanted image, else the fallback, said out loud, else a failure", () => {
  const dir = tmp();
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const stub = (okImages) => {
    writeFileSync(join(bin, "docker"), `#!/bin/sh\n[ "$1" = pull ] || exit 0\nfor a in "$@"; do case " ${okImages} " in *" $a "*) exit 0;; esac; done\nexit 1\n`);
    chmodSync(join(bin, "docker"), 0o755);
  };
  const pick = (...args) => spawnSync("bash", [join(LAB, "ubuntu-pick.sh"), ...args], { env: { ...CLEAN_ENV, PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8" });
  stub("ubuntu:26.04 ubuntu:24.04");
  assert.equal(pick().stdout.trim(), "ubuntu:26.04 exact");
  stub("ubuntu:24.04");
  assert.equal(pick().stdout.trim(), "ubuntu:24.04 fallback");
  assert.equal(pick("ubuntu:99.04", "ubuntu:24.04").stdout.trim(), "ubuntu:24.04 fallback");
  stub("");
  const none = pick();
  assert.equal(none.status, 1);
  assert.match(none.stderr, /neither .* could be pulled/);
  const l14 = read("l14-ubuntu-source.sh");
  assert.match(l14, /::warning title=Ubuntu 26\.04 not tested::/, "a fallback is a workflow warning, never a silent pass");
  assert.match(l14, /L14_UBUNTU=\$KIND/);
  assert.match(l14, /export LAB_INSTALLER_IMAGE="\$TOOLS"/);
});

test("migrate.sh: the installer runs on the host, or inside LAB_INSTALLER_IMAGE with the token by name only", () => {
  const m = read("migrate.sh");
  assert.match(m, /runner=\(sh\)/);
  assert.match(m, /runner=\(docker run --rm -i --network host -v \/var\/run\/docker\.sock:\/var\/run\/docker\.sock -e TUGRA_MIGRATION_TOKEN "\$LAB_INSTALLER_IMAGE" sh\)/);
  assert.doesNotMatch(m, /-e "?TUGRA_MIGRATION_TOKEN=/, "the token is never put on an argv");
  assert.match(m, /TUGRA_MIGRATION_TOKEN="\$MIG_TOKEN" "\$\{runner\[@\]\}" -s --/);
});

test("L9: --stop-source on a running uuid-named source, the 18 refusal restarts it, and the logical lane hits the cap", () => {
  const s = read("l9-fleet-pg.sh");
  assert.match(s, /SRC="\$\(fleet_uuid\)"/);
  assert.match(s, /--arms all --stop-source/);
  assert.match(s, /lab_expect_item dry volume-skipped-running/);
  assert.match(s, /the source the migrator stopped for the refused copy is running again/);
  assert.match(s, /--engine POSTGRES --data-mode dump/);
  assert.match(s, /lab_expect_item logical failed dump-too-big/);
  assert.match(s, /LAYOUT_TEXT="PostgreSQL 18 data layout is not supported by Tugra database volumes yet"/);
  assert.match(s, /fleet_snapshot_others "\$SRC" "tugra_db_\$DB_ID"/, "the database the hub starts is the one expected difference");
  assert.ok(s.indexOf("lab_run dry") < s.indexOf("lab_run copy"), "a plain dry run comes before the stopping run");
  assert.ok(s.indexOf("fleet_pg_load_ticks") < s.indexOf("SRC_COUNT="), "rows are counted after the load");
  // the 256 MiB artifact cap is only asserted when the data compresses over it
  assert.match(s, /\[ "\$MIB" -ge 1024 \]/);
  assert.match(read("fleet.sh"), /POSTGRES_DB=postgres/, "the logical dump reads the database name from the environment");
  // the size compared after the copy is frozen: no autovacuum or BRIN autosummarize between the reading and the stop
  const f = read("fleet.sh");
  const load = f.slice(f.indexOf("fleet_pg_load_ticks() {"), f.indexOf("# ---- MariaDB"));
  assert.match(load, /autovacuum_enabled = false, toast\.autovacuum_enabled = false/);
  assert.match(load, /brin \(ts\) with \(autosummarize = off\)/);
  assert.ok(load.indexOf("vacuum (analyze) ticks") > load.indexOf("insert into ticks"), "one explicit vacuum after the load settles the forks");
});

test("L10: the dump size decides: a 32 MiB cap, the default cap, then the real size", () => {
  const s = read("l10-fleet-mariadb.sh");
  assert.match(s, /--kind db --engine MARIADB --version 11/);
  assert.match(s, /--max-gz-bytes 33554432/);
  assert.match(s, /lab_expect_item capped failed dump-too-big/);
  assert.match(s, /lab_expect_item over failed dump-too-big/);
  assert.ok(s.indexOf("lab_run under") < s.indexOf("lab_run over"), "the small database first, then it grows to the real size");
  assert.match(s, /OVER="\$\{L10_OVER_MIB:-1800\}"/, "the real mariadb is 1.8 GB");
  assert.doesNotMatch(s, /--stop-source/, "the logical arm never stops the source");
  assert.match(s, /fleet_running "\$SRC"/);
  assert.match(read("fleet.sh"), /sha2\(rand\(\), 512\)/, "incompressible-ish text, not zeros");
});

test("L11: the bind mount is refused by default, a system path stays refused, --allow-bind measures and copies it", () => {
  const s = read("l11-fleet-minio.sh");
  assert.match(s, /lab_expect_item refused volume-bind-refused bind-mount/);
  assert.match(s, /-v \/etc\/tugra:\/data:ro/);
  assert.match(s, /--dry-run --allow-bind --stop-source/);
  assert.match(s, /--arms all --allow-bind --stop-source/);
  assert.match(s, /docker's volume accounting does not see the bind data/);
  assert.match(s, /compare\.sh" "\$BIND" "\$DEST_VOLUME"/);
  assert.match(s, /mc diff|fleet_mc diff/);
  assert.match(s, /test "\$BUCKETS" = 12/);
  // the bind lives below /mnt (the real estate's attached volumes), and the migrator's own bind charset accepts it
  assert.match(read("fleet.sh"), /FLEET_BIND_ROOT:-\/mnt\/tugra-lab-binds/);
  assert.match("/mnt/tugra-lab-binds/minio-a", /^\/[A-Za-z0-9._@+/-]+$/);
});

test("L12: A to F cases and the blast-radius check after every one", () => {
  const s = read("l12-fleet-hosts.sh");
  for (const c of ["A: ok", "B: ok", "C: ok", "D: ok", "E: ok"]) assert.ok(s.includes(c), `case ${c} missing`);
  assert.match(s, /lab_expect_item a-dry volume-skipped-running/);
  assert.match(s, /lab_expect_item a-plan planned would-stop-source/);
  assert.match(s, /lab_expect_item b failed ambiguous/);
  assert.match(s, /lab_expect_item d-dry volume-skipped-running/);
  assert.match(s, /--restart always/);
  assert.equal((s.match(/case_untouched( |$)/gm) ?? []).length >= 7, true, "every case, A to F, checks that nothing else changed");
  assert.match(s, /seq 1 12\); do fleet_redis/, "12 plain redis plus the plain and the custom-conf one: 14");
  assert.match(s, /UNLISTED="\$\(fleet_uuid\)"/);
  assert.match(s, /fleet_orphan_volumes 3 20/);
  assert.match(s, /FLEET_MEILI_OLD|L12_MEILI/);
  // E: a dry run never touches docker, so only the real logical run can prove the password on the command line was found
  const e = s.slice(s.indexOf("# ---- E:"), s.indexOf("# ---- F:"));
  assert.match(e, /lab_run "redis-\$tag-real" --arms databases\n/, "the real logical arm, no --dry-run");
  assert.match(e, /password-not-discoverable \| acl-user-unsupported\) lab_die/);
  assert.match(e, /was dumped and uploaded[^\n]*"\$\(lab_item "redis-\$tag-real" bytes/);
  assert.doesNotMatch(s.split("\n").filter((l) => l.startsWith("#")).join("\n"), /dry run discovers/, "the header does not claim a dry run discovers anything");
  // F: the blast-radius check closes the case, with the case's own containers excluded
  const f = s.slice(s.indexOf("# ---- F:"));
  assert.match(f, /case_untouched "\$NAME_F" lab-meili-dst-old lab-meili-dst-new/);
  assert.ok(f.indexOf("case_untouched") > f.indexOf("L12_MEILI_LATEST_OPENS"), "after every container F started");
  // Meilisearch latest is recorded, never a gate
  assert.doesNotMatch(s, /lab_die[^\n]*latest/);
  assert.match(read("fleet.sh"), /FLEET_MEILI_OLD:=getmeili\/meilisearch:v1\.31\.0/);
});

test("L13: every team token is connected and planned, and the counts are the token's", () => {
  const s = read("l13-fleet-coolify.sh");
  assert.match(s, /\/teams is unfiltered/);
  assert.match(s, /POST \/import\/connect/);
  assert.match(s, /POST \/import\/plan/);
  assert.match(s, /totals\.apps/);
  assert.match(s, /no other team's resource leaked in/);
  assert.match(s, /--bind 0\.0\.0\.0/, "the hub's SSRF guard refuses loopback, so the mock listens on the docker host address");
  assert.match(read("coolify-mock.mjs"), /refuses loopback/);
});

test("L8: more migrators than seats, 2 to 4 migrators, all started together", () => {
  const s = read("l8-relay-seats.sh");
  assert.match(s, /L8_MIGRATORS must be 2, 3 or 4/);
  assert.match(s, /must exceed L8_SEATS/);
  assert.match(s, /"MIGRATION_RELAY_CONCURRENCY=\$SEATS"/);
  assert.ok(s.indexOf('LAB_OP="m$n" lab_run_bg "m$n"') > s.indexOf("lab_run_bg m2"), "m3 and m4 start right after m2");
  assert.match(s, /L8_MIGRATORS=\$N L8_SEATS=\$SEATS/);
  // the default shape is unchanged: two migrators, one seat
  assert.match(s, /N="\$\{L8_MIGRATORS:-2\}"/);
  assert.match(s, /SEATS="\$\{L8_SEATS:-1\}"/);
});

test("L4 and the fixture: the owners of the real estate (999, 70, 65534, 1000) and a PostgreSQL heap kind", () => {
  const f = read("fixture.sh");
  for (const needle of ["chown -R 65534:65534 nobody-dir", "chown -R 1000:1000 app-dir", "chown 999:999 secret/f", "chown 70:70 empty"]) assert.ok(f.includes(needle), `fixture lacks ${needle}`);
  const t = read("vx-tar-fidelity.sh");
  assert.match(t, /nobody-dir is 65534:65534 0750/);
  assert.match(t, /app-dir is 1000:1000 0755/);
  assert.match(f, /pgheap\) SRCDEV= ;;/);
  assert.match(f, /docker stop -t 120 "\$PGC"/, "a clean shutdown: a checkpointed data directory");
  assert.match(read("l7-memory.sh"), /run_case pgheap/);
  assert.match(read("l7-memory.sh"), /L7_PGHEAP_MIB:-1536/);
});

test("L6 and L0: pgvector keeps its extension data, a dry run with --stop-source stops nothing", () => {
  const l6 = read("l6-postgres.sh");
  assert.match(l6, /create extension vector/);
  assert.match(l6, /the pgvector table and its extension came across/);
  const l0 = read("l0-dry-run.sh");
  assert.match(l0, /lab_expect_item wouldstop planned would-stop-source/);
});
