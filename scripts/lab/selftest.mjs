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
  assert.deepEqual(jobs.map((j) => j.key), ["tar", "core", "restart", "postgres", "memory", "seats", "throttle"]);
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
  assert.deepEqual(selected("all").length, 7);
  assert.deepEqual(selected("", "schedule").length, 7);
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

test("L8: the second migrator starts only after the first committed a part, and the tap proves contention", () => {
  const s = read("l8-relay-seats.sh");
  const m1 = s.indexOf("lab_run_bg m1");
  const wait = s.indexOf("lab_wait_part m1 0");
  const m2 = s.indexOf("lab_run_bg m2");
  assert.ok(m1 > 0 && wait > m1 && m2 > wait, "m1, then wait for its first part, then m2");
  assert.match(s, /lab_run_bg m1 --hub "\$LAB_TAP_URL"/);
  assert.match(s, /lab_run_bg m2 --hub "\$LAB_TAP_URL"/);
  assert.match(s, /lab_check "the migration seat pool was contended/);
});
