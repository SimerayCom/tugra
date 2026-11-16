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
import { itemRefFor, resolveDbMode, withStreamMode } from "./seed-mode.mjs";
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
  assert.deepEqual(jobs.map((j) => j.key), ["tar", "core", "restart", "postgres", "memory", "seats", "throttle", "fleetpg", "fleetdb", "fleetminio", "fleethosts", "fleetcoolify", "ubuntu", "streamdump", "pgtls"]);
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
  assert.deepEqual(selected("all").length, 15);
  assert.deepEqual(selected("", "schedule").length, 15);
  // the fleet-shaped items: by name, as a group, and never by substring
  assert.deepEqual(selected("fleetpg"), ["fleetpg"]);
  assert.deepEqual(selected("fleet"), ["fleetpg", "fleetdb", "fleetminio", "fleethosts", "fleetcoolify", "ubuntu"]);
  assert.deepEqual(selected("tar,fleet,seats"), ["tar", "seats", "fleetpg", "fleetdb", "fleetminio", "fleethosts", "fleetcoolify", "ubuntu"]);
  assert.deepEqual(selected("postgres"), ["postgres"], "postgres must not also select fleetpg");
  assert.deepEqual(selected("fleetdb, ubuntu"), ["fleetdb", "ubuntu"]);
  // the data-plane legs: by name, or as the `stream` group, and `fleet` does not select them
  assert.deepEqual(selected("streamdump"), ["streamdump"]);
  assert.deepEqual(selected("pgtls"), ["pgtls"]);
  assert.deepEqual(selected("stream"), ["streamdump", "pgtls"]);
  assert.deepEqual(selected("fleet").includes("streamdump"), false);
  assert.deepEqual(selected("postgres"), ["postgres"], "postgres must not select pgtls either");
});

test("workflow: L15 and L16 matrices, their scripts and the artifacts the integrity checks write", () => {
  const yml = readFileSync(join(ROOT, ".github/workflows/vx-lab.yml"), "utf8");
  const section = (key) => new RegExp(`^  ${key}:\n[\\s\\S]*?(?=^  [a-z]+:\n|(?![\\s\\S]))`, "m").exec(yml)?.[0] ?? "";
  for (const img of ["postgres:17-alpine", "pgvector/pgvector:pg17", "postgres:18-alpine", "mariadb:11"]) assert.ok(section("streamdump").includes(`- ${img}`), `L15 matrix lacks ${img}`);
  for (const img of ["postgres:16-alpine", "postgres:17-alpine", "postgres:18-alpine", "pgvector/pgvector:pg17"]) assert.ok(section("pgtls").includes(`- ${img}`), `L16 matrix lacks ${img}`);
  assert.match(section("streamdump"), /L15_IMAGE: \$\{\{ matrix\.image \}\}/);
  assert.match(section("pgtls"), /L16_IMAGE: \$\{\{ matrix\.image \}\}/);
  assert.ok(section("streamdump").includes("scripts/lab/l15-stream-dump.sh") && existsSync(join(LAB, "l15-stream-dump.sh")));
  assert.ok(section("pgtls").includes("scripts/lab/l16-pg-tls.sh") && existsSync(join(LAB, "l16-pg-tls.sh")));
  assert.ok(section("streamdump").includes("name: vx-lab-streamdump-${{ strategy.job-index }}") && section("pgtls").includes("name: vx-lab-pgtls-${{ strategy.job-index }}"));
  // every job's log collection ships the scenario summaries and the fingerprints, not only l7 and l8
  for (const line of yml.split("\n").filter((l) => l.includes('cp -f "$LAB_DIR"/*.log'))) {
    assert.ok(line.includes('"$LAB_DIR"/*.summary') && line.includes('"$LAB_DIR"/*.fp.*'), `a log collection misses the summaries or fingerprints: ${line.trim().slice(0, 80)}`);
  }
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

test("manifest: the volume root, the setuid digit and FIFO mtimes are compared, symlink mtimes are not", (t) => {
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
  assert.equal(manifest(d, shim), base, "a symlink mtime is a documented non-copy (busybox tar cannot set it)");
  lutimesSync(join(d, "link"), new Date("2023-01-15T10:30:45Z"), new Date("2023-01-15T10:30:45Z"));
  spawnSync("touch", ["-t", "202401010101", join(d, "fifo")]);
  assert.notEqual(manifest(d, shim), base, "a FIFO mtime must change the manifest");
  // directory mtimes stay out of the default manifest (reported separately)
  const again = tree();
  assert.equal(manifest(again, shim).split("\n").filter((l) => l.startsWith("./sub|")).length, 1);
});

test("tarlist: only DIRECTORY and SYMLINK mtimes are masked", (t) => {
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
  assert.equal(list(d), base, "symlink mtime is masked (busybox tar cannot set it)");
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
  assert.doesNotMatch(s.slice(m1, released), /lab_wait_part/, "no migrator waits for another to commit a part: all start together behind the barrier");
  assert.match(s, /LAB_TAP_BARRIER="\$N" lab_tap_start/);
  assert.match(s, /lab_run_bg m1 --hub "\$LAB_TAP_URL"/);
  assert.match(s, /lab_run_bg m2 --hub "\$LAB_TAP_URL"/);
  assert.match(s, /lab_check "the migration seat pool was contended/);
  assert.match(s, /Runbook finding 2 \(fixed in the migrator\)/, "the header names the product finding and its fix");
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
  assert.match(seed, /kv\("ITEMREF", itemRefFor\(plan, f\.kind, f\.source, f\.volume\)\)/, "the op reports the row its lane moves");
  assert.match(seed, /proposed: plan\.mode === "volume" \? \{ dataMode: "volume" \}/, "only a physical op carries dataMode volume");
  // the migrator row of each lane: the database ref (artifact route), the volume ref (physical copy, app volume), `<ref>:dump` (stream)
  assert.equal(itemRefFor({ mode: "dump" }, "db", "src1", "data"), "database:_:src1");
  assert.equal(itemRefFor({ mode: "volume" }, "db", "src1", "data"), "volume:_:src1:data");
  assert.equal(itemRefFor({ mode: "volume" }, "app", "src1", "media"), "volume:_:src1:media");
  assert.equal(itemRefFor({ mode: "stream" }, "db", "src1", "data"), "volume:_:src1:dump");
});

test("seed: the streamed dump lane is PostgreSQL, MariaDB and MySQL, and a stream op puts its database in meta.vxStream", () => {
  assert.deepEqual(resolveDbMode("db", "POSTGRES", "stream"), { engine: "POSTGRES", mode: "stream" });
  assert.deepEqual(resolveDbMode("db", "MARIADB", "stream"), { engine: "MARIADB", mode: "stream" });
  assert.throws(() => resolveDbMode("db", "REDIS", "stream"), /PostgreSQL, MariaDB and MySQL/);
  // what DATA_SEED writes: a new object, the op's other meta untouched, and off removes only that database
  const meta = { serverId: "s1", plan: { items: [] } };
  const on = withStreamMode(meta, "database:_:src1", true, "u1", "2026-01-01T00:00:00.000Z");
  assert.deepEqual(on.vxStream, { "database:_:src1": { at: "2026-01-01T00:00:00.000Z", by: "u1" } });
  assert.equal(on.serverId, "s1");
  assert.equal(meta.vxStream, undefined, "the input meta is not mutated");
  const two = withStreamMode(on, "database:_:src2", true, "u1", "t");
  assert.deepEqual(Object.keys(two.vxStream).sort(), ["database:_:src1", "database:_:src2"]);
  assert.deepEqual(Object.keys(withStreamMode(two, "database:_:src1", false, "u1", "t").vxStream), ["database:_:src2"]);
  assert.deepEqual(withStreamMode(null, "database:_:x", true, "u", "t").vxStream, { "database:_:x": { at: "t", by: "u" } });
  const seed = read("seed.mjs");
  assert.match(seed, /streamMeta = withStreamMode\(\{\}, ownerRef, true, userId/);
  assert.match(seed, /\.\.\.\(streamMeta \? \{ vxStream: streamMeta \} : \{\}\)/);
  assert.match(seed, /--ssl is PostgreSQL only/);
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
  // the 4 GiB table is compared by content, never by bytes after a stop (pg_total_relation_size legitimately moves)
  assert.doesNotMatch(s, /test "\$DST_SIZE" = "\$SRC_SIZE"/);
  assert.match(s, /lab_fingerprint_compare l9 "\$LAB_DIR\/l9\.fp\.src" "\$LAB_DIR\/l9\.fp\.dst" L9 strict-access/);
  // the dump-too-big of the artifact route is the DEFAULT policy; the same source then goes through the streamed lane (largeDbMode stream-logical)
  assert.match(s, /--data-mode stream/);
  assert.match(s, /lab_stream_expect_applied stream/);
  assert.match(s, /L9_STREAM:-1/);
  assert.doesNotMatch(s, /no automatic lane on PostgreSQL 18\)"/, "the stale finding is gone: stream-logical is the lane");
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
  // the over-cap run is a FRESH op: the first one is restored, and a second run on it reports already-restored (lab run 3)
  assert.match(s, /lab_seed op --name "lab-over-[^\n]*--data-mode dump >"\$LAB_DIR\/op\.over\.env"/);
  assert.match(s, /LAB_OP=over lab_run over --arms databases/);
  assert.match(s, /lab_expect_item under restored/);
  // the same database on the streamed lane, compared by fingerprint, with the source untouched
  assert.match(s, /--data-mode stream/);
  assert.match(s, /lab_fingerprint_compare l10-stream/);
  assert.match(s, /L10_STREAM:-1/);
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
  // the image: minio/minio and minio/mc are not pullable (lab run 3), so the pin is a pullable archive by digest and mc is the agent image's own
  const fl = read("fleet.sh");
  assert.doesNotMatch(fl.split("\n").filter((l) => l.startsWith(": ")).join("\n"), /minio\/minio|minio\/mc/);
  assert.match(fl, /FLEET_MINIO_IMAGE:=bitnamilegacy\/minio:2025\.4\.22@sha256:[0-9a-f]{64}/);
  assert.match(fl, /FLEET_MC_IMAGE:=\$\{LAB_IMAGE/);
  assert.match(fl, /--entrypoint mc "\$FLEET_MC_IMAGE"/);
  assert.match(fl, /--entrypoint minio "\$FLEET_MINIO_IMAGE" server \/data/);
  assert.match(fl, /fleet_pull "\$FLEET_MINIO_IMAGE"/);
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
  // the hub starts the destination redis when it restores the dump: those containers are named, never a blanket allowance
  assert.match(e, /DEST_DBS\+=\("tugra_db_\$\(sed -n 's\/\^DB_ID=\/\/p'/);
  assert.match(e, /case_untouched "\$\{DEST_DBS\[@\]\}"/);
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
  assert.match(read("integrity.sh"), /create extension if not exists vector/);
  assert.match(l6, /lab_pg_integrity_seed labsrc tugra postgres "\$VEC_ARG"/);
  assert.match(l6, /the pgvector table and its extension came across/);
  const l0 = read("l0-dry-run.sh");
  assert.match(l0, /lab_expect_item wouldstop planned would-stop-source/);
});

// ---- data integrity: fingerprints, the streamed dump lane and TLS legs ------------------------------------------------------------
// A docker stub that records its argv and prints a canned answer, so the shell helpers can be exercised without a daemon.
function fakeDocker(dir, body) {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "docker"), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, "docker"), 0o755);
  return { PATH: `${bin}:${process.env.PATH}`, LAB_DIR: dir };
}

test("L6: the destination is compared by content (a checksum over every column and the access objects), never by bytes after SIGKILL", () => {
  const s = read("l6-postgres.sh");
  assert.doesNotMatch(s, /test "\$DST_SIZE" = "\$SRC_SIZE"/, "pg_total_relation_size moves after crash recovery (lab run 3: 234553344 vs 234627072 with every row equal)");
  assert.match(s, /lab_fingerprint_compare l6 "\$LAB_DIR\/l6\.fp\.src" "\$LAB_DIR\/l6\.fp\.dst" L6 strict-access/, "a physical copy carries the whole cluster: roles and grants are strict");
  assert.ok(s.indexOf('lab_pg_fingerprint labsrc') < s.indexOf("docker kill labsrc"), "the source is fingerprinted before the unclean stop");
  assert.match(s, /\. "\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\)\/integrity\.sh"/);
});

test("integrity: strict facts must be equal, the access objects are strict for a physical copy and a recorded finding for a dump", () => {
  const dir = tmp();
  const run = (src, dst, extra = "", env = {}) => {
    writeFileSync(join(dir, "s.fp"), src);
    writeFileSync(join(dir, "d.fp"), dst);
    return bash(`. ${join(LAB, "integrity.sh")}; lab_fingerprint_compare l10-stream ${join(dir, "s.fp")} ${join(dir, "d.fp")} L10_STREAM ${extra}`, { LAB_DIR: dir, ...env });
  };
  const strict = "strict.rows=500000:123\nstrict.seq.lab_seq=7777\nstrict.extensions=vector@0.8.0\n";
  const access = "access.owner=lab_app\naccess.acl={lab_app=arwdDxt/lab_app,lab_ro=r/lab_app}\n";
  const summary = () => readFileSync(join(dir, "l10.summary"), "utf8");
  // everything equal: carried
  let r = run(strict + access, strict + access);
  assert.equal(r.status, 0, r.stderr);
  assert.match(summary(), /L10_STREAM_ACCESS=carried/);
  // a strict difference fails, with the diff on stderr: the data does not mean the same on the target
  r = run(strict + access, strict.replace("7777", "1") + access);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /-strict\.seq\.lab_seq=7777/);
  assert.match(r.stderr, /strict fingerprint differs/);
  r = run(strict + access, strict.replace("123", "124") + access);
  assert.equal(r.status, 1, "a different checksum over the rows is a failure");
  // an empty source fingerprint is a harness failure, never a vacuous pass
  r = run("", "");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /source fingerprint is empty/);
  // an access difference in a dump lane: recorded as a FINDING, not a failure
  const dropped = "access.owner=tugra\naccess.acl=none\n";
  r = run(strict + access, strict + dropped);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /FINDING l10-stream/);
  assert.match(summary(), /L10_STREAM_ACCESS=dropped/);
  // ...a failure for a physical copy (strict-access) and when required
  r = run(strict + access, strict + dropped, "strict-access");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /were not carried/);
  r = run(strict + access, strict + dropped, "", { L_INTEGRITY_ACCESS: "require" });
  assert.equal(r.status, 1);
});

test("integrity: the PostgreSQL and MariaDB fingerprints read the same facts from source and destination", () => {
  const dir = tmp();
  const env = fakeDocker(dir, `printf '%s\\n' "$*" >>"$LAB_DIR/argv"; for a in "$@"; do last="$a"; done; printf '%s\\n' "$last" >>"$LAB_DIR/sql"; echo "strict.rows=1:2"`);
  const run = (cmd) => bash(`. ${join(LAB, "integrity.sh")}; ${cmd}`, env);
  assert.equal(run("lab_pg_fingerprint src tugra postgres ticks vector").status, 0);
  const sql = readFileSync(join(dir, "sql"), "utf8");
  // rows by count AND a checksum over every column of every row (not a byte size), extensions, sequences' last_value, collation, roles, owner, ACL
  for (const frag of ["hashtextextended(x::text, 0)), 0) from ticks x", "pg_extension", "pg_sequences", "lab_seq", "lab_ser_id_seq", "datcollate", "collate", "pg_roles", "tableowner", "relacl", "lab_v x", "hnsw"]) {
    assert.ok(sql.toLowerCase().includes(frag.toLowerCase()), `the PostgreSQL fingerprint lacks ${frag}`);
  }
  assert.doesNotMatch(sql, /pg_total_relation_size/);
  // without the vector flag the pgvector facts are not asked for
  writeFileSync(join(dir, "sql"), "");
  run("lab_pg_fingerprint src tugra postgres lab_t");
  assert.doesNotMatch(readFileSync(join(dir, "sql"), "utf8"), /lab_v/);
  writeFileSync(join(dir, "sql"), "");
  assert.equal(run("lab_maria_fingerprint src pw fleetdb").status, 0);
  const m = readFileSync(join(dir, "sql"), "utf8");
  for (const frag of ["sum(crc32(v))", "auto_increment", "default_collation_name", "table_collation", "mysql.user", "schema_privileges", "information_schema.routines"]) assert.ok(m.toLowerCase().includes(frag.toLowerCase()), `the MariaDB fingerprint lacks ${frag}`);
  // the password rides the environment of docker exec by name=value into the container, never an argument of a mariadb option
  assert.doesNotMatch(readFileSync(join(dir, "argv"), "utf8").split("\n").filter((l) => l.includes("mariadb")).join("\n"), /-p/);
});

test("integrity: TLS connections ask for sslmode=require over TCP on the container's loopback, a plain one uses the socket", () => {
  const dir = tmp();
  const env = fakeDocker(dir, `printf '%s\\n' "$*" >"$LAB_DIR/argv"; echo t`);
  const run = (cmd, e = {}) => bash(`. ${join(LAB, "integrity.sh")}; ${cmd}`, { ...env, ...e });
  run("lab_pg_q c1 tugra postgres 'select 1'");
  assert.doesNotMatch(readFileSync(join(dir, "argv"), "utf8"), /PGSSLMODE|-h 127/);
  run("lab_pg_q c1 tugra postgres 'select 1'", { LAB_PG_TLS: "1" });
  const tls = readFileSync(join(dir, "argv"), "utf8");
  assert.match(tls, /-e PGSSLMODE=require/);
  assert.match(tls, /psql -h 127\.0\.0\.1 -U tugra -d postgres/);
});

test("integrity: the seeds create what a row count cannot see", () => {
  const i = read("integrity.sh");
  for (const frag of ["create role lab_app login", "create role lab_ro nologin", "alter table lab_own owner to lab_app", "grant select on lab_own to lab_ro", "setval('lab_seq', 7777)", "collate \\\"C\\\"", "create extension if not exists vector", "using hnsw"]) assert.ok(i.includes(frag), `the PostgreSQL seed lacks ${frag}`);
  for (const frag of ["create user 'lab_u'@'%'", "grant select, insert on", "latin1_bin", "auto_increment=1000", "create function lab_fn"]) assert.ok(i.includes(frag), `the MariaDB seed lacks ${frag}`);
  assert.doesNotMatch(i, /\/etc\//, "the integrity checks never read the host's files");
});

test("L15: the streamed dump lane for PostgreSQL and MariaDB, the hub killed mid-dump, rows and fingerprint verified", () => {
  const s = read("l15-stream-dump.sh");
  assert.match(s, /--data-mode stream/);
  assert.match(s, /lab_stream_plan plan --part-mib 32/);
  assert.match(s, /lab_run_bg stream --hub "\$LAB_PROXY_URL" --arms volumes --part-mib 32 --hub-outage-wait 10m/, "behind the throttle proxy, so a part in flight is a window");
  assert.ok(s.indexOf("lab_wait 900") < s.indexOf('"$LAB_SELF_DIR/hub.sh" kill'), "the hub is killed after a part was committed");
  assert.ok(s.indexOf('"$LAB_SELF_DIR/hub.sh" kill') < s.indexOf('"$LAB_SELF_DIR/hub.sh" start'));
  assert.match(s, /MIGRATION_VX_PART_MIB=32 MIGRATION_VX_STALE_MS=300000/, "the stale window outlives the outage (the L2-A reasoning)");
  const stale = num(s, /MIGRATION_VX_STALE_MS=(\d+)/);
  const outage = num(s, /hub\.sh" kill\nsleep (\d+)/);
  assert.ok(stale >= (outage + 90) * 1000);
  assert.match(s, /lab_stream_expect_applied stream/);
  assert.match(s, /lab_fingerprint_compare l15 /);
  assert.match(s, /the row count equals the source/);
  assert.match(s, /postgres:\* \| pgvector\/\*\)/);
  assert.match(s, /mariadb:\*\)/);
  assert.match(s, /fleet_snapshot_others "\$SRC" "\$DST_CTR"/, "the destination the hub started is the one expected difference");
  assert.match(s, /the source was never stopped or restarted by the dump/);
  assert.doesNotMatch(s, /--stop-source/, "the dump lane never stops the source");
  // a PostgreSQL 18 destination is a named product finding, not a skipped or relaxed check
  assert.doesNotMatch(s, /MAJOR[^\n]*18[^\n]*(skip|exit 0)/i);
  assert.match(read("stream.sh"), /PRODUCT FINDING: the hub refuses a streamed dump into a PostgreSQL 18 destination \(importer\/volume-stream\/vx-dest-gate\.ts dumpDestLayout/);
});

test("stream.sh: the plan measures first with the caller's hub flag in front, and a refused 18 destination is named", () => {
  const s = read("stream.sh");
  assert.match(s, /lab_run "\$tag" "\$@" --arms volumes --dry-run --measure-dbs --measure-dump/, "migrate.sh reads --hub only in front of the other flags");
  assert.match(s, /lab_expect_item "\$tag" planned would-stream-dump/);
  assert.match(s, /lab_expect_item "\$tag" volume-applied/);
});

test("L16: a TLS destination read from inside and from a client container, the restore read back over TLS, the refusal (not the major) skips the restore", () => {
  const s = read("l16-pg-tls.sh");
  assert.match(s, /--data-mode dump --ssl/);
  assert.match(s, /lab_api POST "\/databases\/\$DB_ID\/provision"/);
  assert.match(s, /test "\$\(lab_pg_q "\$CTR" "\$U" "\$D" 'show ssl'\)" = on/);
  assert.match(s, /select ssl from pg_stat_ssl where pid = pg_backend_pid\(\)/);
  assert.match(s, /tls_client require/);
  assert.match(s, /sslmode=verify-ca is refused by libpq's certificate check/);
  assert.match(s, /lab_tls_cert_refusal "\$out"/, "the reason of the verify-ca failure is checked, not just a non-zero exit");
  assert.match(s, /create extension if not exists vector/);
  assert.match(s, /--data-mode stream --ssl/);
  assert.match(s, /export LAB_PG_TLS=1\nlab_check "the restored database is served over TLS/);
  assert.match(s, /L16_RESTORE=skipped-pg18-destination-refused/, "the skip is recorded, not hidden");
  assert.doesNotMatch(s, /\[ "\$MAJOR" -ge 18 \]/, "leg B is decided on the hub's refusal, never on the version, so lifting the gate needs no edit");
  assert.match(s, /lab_stream_refused copy/);
  assert.doesNotMatch(s, /sslmode=disable/);
  // the persistence check: leg A on every major (the 18 image is the one that fails it), after the last TLS read and before leg B
  const persist = s.indexOf("lab_dest_survives_recreate \"$CTR\"");
  assert.ok(persist > s.indexOf("L16_FRESH_TLS=ok") && persist < s.indexOf("# ---- B."), "leg A recreates the fresh destination and recounts, for every major");
  assert.match(s, /L16_PERSISTENCE=lost-on-recreate/);
  assert.match(s, /lab_dest_survives_recreate "\$DST_CTR"/, "the streamed destination is recreated and recounted too");
});

test("lab_stream_refused: the refusal text decides, a failed run of another kind is not blamed on the gate", () => {
  const dir = tmp();
  writeFileSync(join(dir, "run.a.log"), "error: the destination is PostgreSQL 18 or newer, whose data directory Tugra database volumes cannot persist yet\n");
  writeFileSync(join(dir, "run.b.log"), "error: connection reset\n");
  const run = (tag) => bash(`. ${join(LAB, "stream.sh")}; lab_stream_refused ${tag}`, { LAB_DIR: dir });
  assert.equal(run("a").status, 0);
  assert.notEqual(run("b").status, 0);
  assert.notEqual(run("missing").status, 0);
});

test("lab_dest_survives_recreate: the hub's provision route recreates the container, rows lost across it are a named PRODUCT FINDING", () => {
  const body = (psql) => `echo "$*" >>"$LAB_DIR/docker.calls"; case "$*" in *pg_isready*) exit 0;; *psql*) ${psql};; esac; exit 0`;
  const script = (dir) => `. ${join(LAB, "stream.sh")}
lab_api() { echo "api $*" >>"$LAB_DIR/api.calls"; }
lab_wait() { :; }
lab_dest_survives_recreate ctr-1 u d tls_t 100000 db-1`;
  // the rows are all there
  let dir = tmp();
  let r = bash(script(dir), fakeDocker(dir, body("echo 100000")));
  assert.equal(r.status, 0, r.stderr);
  assert.match(readFileSync(join(dir, "api.calls"), "utf8"), /api POST \/databases\/db-1\/provision/);
  assert.match(r.stderr, /holds all 100000 rows/);
  // the table is gone after the recreate (a PostgreSQL 18 cluster outside the named volume): psql fails
  dir = tmp();
  r = bash(script(dir), fakeDocker(dir, body("echo 'ERROR: relation does not exist' >&2; exit 1")));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /PRODUCT FINDING: after the hub recreated the destination container \(ctr-1\) tls_t reads 'lost', not 100000/);
  assert.match(r.stderr, /databases\/database-script\.ts/);
  assert.match(r.stderr, /Every PostgreSQL 18\+ database Tugra provisions is affected, restored or fresh/);
  // a partial table is as lost as a missing one
  dir = tmp();
  r = bash(script(dir), fakeDocker(dir, body("echo 99999")));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /reads '99999'/);
  // the legs that move data call it
  for (const f of ["l15-stream-dump.sh", "l9-fleet-pg.sh"]) assert.match(read(f), /lab_dest_survives_recreate "\$DST_CTR"/, f);
});

test("lab_tls_cert_refusal: only libpq refusing the certificate counts, never any failed connection", () => {
  const ok = (t) => bash(`. ${join(LAB, "integrity.sh")}; lab_tls_cert_refusal "$T"`, { T: t }).status === 0;
  assert.ok(ok('psql: error: connection to server at "10.0.0.2", port 5432 failed: root certificate file "/root/.postgresql/root.crt" does not exist\nEither provide the file or change sslmode to disable server certificate verification.'));
  assert.ok(ok('psql: error: connection to server failed: SSL error: certificate verify failed'));
  assert.ok(!ok('psql: error: connection to server at "10.0.0.2", port 5432 failed: server does not support SSL, but SSL was required'), "a server with no TLS at all");
  assert.ok(!ok('psql: error: connection to server failed: Connection refused'));
  assert.ok(!ok('psql: error: connection failed: FATAL: password authentication failed for user "x"'));
});

test("every translated README names the same MCP tool count as README.md", () => {
  const count = (f) => /(\d+) tools⁵/.exec(readFileSync(join(ROOT, f), "utf8"))?.[1];
  const want = count("README.md");
  assert.ok(want, "README.md states a count");
  for (const l of ["zh", "fr", "tr", "es", "de", "ja", "pt"]) assert.equal(count(`README.${l}.md`), want, `README.${l}.md`);
});

test("fleet.sh: a pull that cannot succeed says which image and why, after retries", () => {
  const dir = tmp();
  const env = fakeDocker(dir, `echo x >>"$LAB_DIR/pulls"; echo 'pull access denied for minio/minio' >&2; exit 1`);
  let r = bash(`. ${join(LAB, "fleet.sh")}; fleet_pull minio/minio:gone`, { ...env, FLEET_PULL_SLEEP: "0" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /cannot pull minio\/minio:gone/);
  assert.match(r.stderr, /pull access denied/);
  assert.equal(readFileSync(join(dir, "pulls"), "utf8").trim().split("\n").length, 3, "three attempts");
  const ok = tmp();
  const env2 = fakeDocker(ok, `exit 0`);
  r = bash(`. ${join(LAB, "fleet.sh")}; fleet_pull alpine:3.21 && echo pulled`, { ...env2, FLEET_PULL_SLEEP: "0" });
  assert.equal(r.stdout.trim(), "pulled");
});

test("migrate.sh and lib.sh: the log tee drains within a bound, a run that never ends names what is still alive", () => {
  const m = read("migrate.sh");
  assert.doesNotMatch(m.split("\n").filter((l) => !l.startsWith("#")).join("\n"), /^wait$/m, "a bare wait has no limit (lab run 3: L1b waited 120 s for a killed migrator's run)");
  assert.match(m, /: >"\$ERR\.done"/);
  assert.match(m, /seq 1 50/);
  assert.match(m, /L_TEE_UNDRAINED=\$TAG/, "an undrained tee is recorded, not silent");
  const l = read("lib.sh");
  assert.match(l, /run \$tag: processes/);
  assert.match(l, /run \$tag: containers/);
});

test("the lab never names a pullable-looking image it cannot pull: minio/minio and minio/mc are gone from fleet.sh", () => {
  assert.doesNotMatch(read("fleet.sh").split("\n").filter((l) => !l.trim().startsWith("#")).join("\n"), /minio\/(minio|mc)[:\s"]/);
});

// ---- review fixes: the SIGKILL copy's sequences, refusal naming before the exit-code check, the killed migrator's docker client -------
test("L6: a checkpoint after the fingerprint and before the SIGKILL, so redo cannot move a serial's last_value", () => {
  const s = read("l6-postgres.sh");
  const fp = s.indexOf("lab_pg_fingerprint labsrc");
  const cp = s.indexOf('psql_src "checkpoint"');
  const kill = s.indexOf("docker kill labsrc");
  assert.ok(fp > 0 && cp > fp, "the checkpoint comes after the source fingerprint");
  assert.ok(kill > cp, "and before the kill");
  assert.equal(s.slice(cp, kill).split("\n").filter((l) => l.trim() && !l.startsWith("#")).length, 1, "nothing but the checkpoint runs before the kill (no new WAL)");
  assert.match(s, /not properly shut down/, "the WAL replay evidence is still asserted");
});

test("stream legs: a PostgreSQL 18 refusal is named before any exit-code check can die with a generic message", () => {
  const dir = tmp();
  writeFileSync(join(dir, "run.stream.log"), "error: the destination refused: PostgreSQL 18 or newer is not supported\n");
  const r = bash(`. ${join(LAB, "stream.sh")}; lab_stream_fail stream "migrator exit 1"`, { LAB_DIR: dir });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /PRODUCT FINDING: the hub refuses a streamed dump into a PostgreSQL 18 destination/);
  assert.match(r.stderr, /FAIL: migrator exit 1/);
  const clean = tmp();
  writeFileSync(join(clean, "run.stream.log"), "error: something else\n");
  const r2 = bash(`. ${join(LAB, "stream.sh")}; lab_stream_fail stream "migrator exit 1"`, { LAB_DIR: clean });
  assert.equal(r2.status, 1);
  assert.doesNotMatch(r2.stderr, /PRODUCT FINDING/, "a run that failed for another reason is not blamed on the gate");
  for (const [f, tag] of [["l9-fleet-pg.sh", "stream"], ["l10-fleet-mariadb.sh", "stream"], ["l16-pg-tls.sh", "copy"], ["l15-stream-dump.sh", "stream"]]) {
    const t = read(f);
    assert.ok(!t.includes(`tail -40 "$LAB_DIR/run.${tag}.log" >&2; lab_die`), `${f} dies through lab_stream_fail`);
    assert.match(t, /lab_stream_(fail|note_refusal)/);
  }
  const l15 = read("l15-stream-dump.sh");
  const early = l15.indexOf("lab_stream_note_refusal stream");
  assert.ok(early > 0 && early < l15.indexOf('if [ "$(lab_last_part stream)" -lt 1 ]') && early < l15.indexOf("finished before the hub could be killed"), "the early exit names the refusal first");
  assert.match(l15, /ended before any part was committed/, "a run with no committed part is a refusal or failure, not a small dump");
  // a run that committed parts and then failed is a failure, only a clean exit 0 is "too small"
  const fail = l15.indexOf('if [ "$early_rc" != 0 ]');
  assert.ok(fail > 0 && fail < l15.indexOf("the dump finished before the hub could be killed in flight") && /lab_stream_fail stream "the streamed run failed after part/.test(l15.slice(fail)), "a non-zero early exit dies with the migrator failure and the log tail");
  assert.match(l15, /the migrator exited 0/);
  // the outage is evidenced: still running at the kill, and parts committed after the restart
  assert.ok(l15.indexOf('[ ! -f "$LAB_DIR/run.stream.rc" ]') < l15.indexOf('"$LAB_SELF_DIR/hub.sh" kill'), "no exit code at the moment of the kill");
  assert.match(l15, /PART_AT_KILL="\$\(lab_last_part stream\)"/);
  assert.match(l15, /test "\$\(lab_last_part stream\)" -gt "\$PART_AT_KILL"/, "parts moved after the outage");
  assert.match(l15, /lab_dest_survives_recreate/);
});

test("lab_kill9_migrator: kills by name, waits a bound for the run's docker client, kills a stuck one, records it, fails under CI", (t) => {
  if (spawnSync("bash", ["-c", "command -v pgrep && command -v pkill"]).status !== 0) return t.skip("pgrep or pkill is missing");
  const dir = tmp();
  const env = fakeDocker(dir, `echo "$*" >>"$LAB_DIR/docker.calls"; case "$1" in ps) echo tugra-migrator-4242;; esac; exit 0`);
  // a stand-in for the installer's stuck `docker run` client
  const standIn = () => spawn("bash", ["-c", "sleep 60; exit 0", "stuck-docker-client", "--name", "tugra-migrator-4242"], { stdio: "ignore", detached: true });
  const live = [];
  try {
    let stuck = standIn(); live.push(stuck);
    const r = bash(`. ${join(LAB, "lib.sh")}; lab_kill9_migrator`, { ...env, LAB_KILL_REAP_TICKS: "2" });
    assert.equal(r.status, 0, r.stderr);
    const calls = readFileSync(join(dir, "docker.calls"), "utf8");
    assert.match(calls, /kill --signal KILL tugra-migrator-4242/);
    assert.match(calls, /rm -f tugra-migrator-4242/);
    assert.match(r.stderr, /FINDING: the docker client of the SIGKILLed migrator tugra-migrator-4242 did not exit within the bound/);
    assert.match(readFileSync(join(dir, "l1b.summary"), "utf8"), /^L1B_KILL_FORCED=tugra-migrator-4242$/m, "what had to be forced is recorded for the integrator");
    assert.equal(spawnSync("pgrep", ["-f", "--", "--name tugra-migrator-4242"]).status, 1, "the stuck client was killed");
    // under CI a forced kill is a failure (the product's docker client hung, the lab only covered for it), unless knowingly allowed
    writeFileSync(join(dir, "docker.calls"), "");
    stuck = standIn(); live.push(stuck);
    const ci = bash(`. ${join(LAB, "lib.sh")}; lab_kill9_migrator`, { ...env, LAB_KILL_REAP_TICKS: "2", CI: "true" });
    assert.equal(ci.status, 1, "a forced kill under CI must fail the scenario");
    assert.match(ci.stderr, /the installer's docker client did not exit after its migrator container was SIGKILLed \(tugra-migrator-4242\)/);
    assert.match(readFileSync(join(dir, "docker.calls"), "utf8"), /rm -f tugra-migrator-4242/, "the container is still removed before the scenario fails");
    stuck = standIn(); live.push(stuck);
    const allowed = bash(`. ${join(LAB, "lib.sh")}; lab_kill9_migrator`, { ...env, LAB_KILL_REAP_TICKS: "2", CI: "true", LAB_ALLOW_FORCED_KILL: "1" });
    assert.equal(allowed.status, 0, allowed.stderr);
  } finally {
    for (const p of live) { try { process.kill(-p.pid, "SIGKILL"); } catch { /* already gone */ } }
  }
  // a client that exits on its own is not a finding, even under CI
  const clean = tmp();
  const cleanEnv = fakeDocker(clean, `case "$1" in ps) echo tugra-migrator-4243;; esac; exit 0`);
  const rc = bash(`. ${join(LAB, "lib.sh")}; lab_kill9_migrator`, { ...cleanEnv, CI: "true" });
  assert.equal(rc.status, 0, rc.stderr);
  assert.equal(existsSync(join(clean, "l1b.summary")), false);
  const none = fakeDocker(tmp(), `exit 0`);
  const r2 = bash(`. ${join(LAB, "lib.sh")}; lab_kill9_migrator`, none);
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /no migrator container is running/);
});
