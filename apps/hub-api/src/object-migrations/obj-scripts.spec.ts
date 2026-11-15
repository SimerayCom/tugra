import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HELPER_FLAGS,
  buildObjCleanupScript,
  buildObjConfigApplyScript,
  buildObjDiffScript,
  buildObjDuScript,
  buildObjProbeScript,
  buildObjStartScript,
  buildObjStatusScript,
  objPrelude,
  type ObjSides,
} from "./obj-scripts";
import { parseCfgResults, parseDiff, parseDuOutput, parseProbe, parseStarted, parseStatus } from "./obj-parse";
import { MC_DIFF_JSON, MC_DU_JSON, MC_ILM_JSON, MC_LS_JSON, MC_MIRROR_JSON, MC_MIRROR_OUT_OF_ORDER_JSON, MC_POLICY_JSON, MC_TAGS_JSON, MC_VERSION_INFO_ENABLED } from "./testing/mc-fixtures";

const ID = "ckobjmigabcdefghijklmnop"; // cuid-shaped
const SECRET_PW = "p@ss'w\"o!rd~$`\;&|";
const sides: ObjSides = {
  src: { endpoint: "https://src.example.com:9000", accessKey: "SRC'AK!~", secretKey: SECRET_PW },
  dst: { endpoint: "http://host.docker.internal:9100", accessKey: "DST$AK", secretKey: "d`st\\sk" },
};

const bashSyntax = (script: string): { status: number | null; stderr: string } => {
  const r = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
  return { status: r.status, stderr: r.stderr };
};

describe("prelude (golden)", () => {
  const p = objPrelude(sides).split("\n");
  it("starts with the fixed guard lines and ends with the two helper functions", () => {
    expect(p[0]).toBe("set -u; umask 077");
    expect(p[1]).toBe('IMG="${TUGRA_AGENT_IMAGE:-}"; [ -n "$IMG" ] || { echo "TUGRA_OBJ_ERR no-agent-image"; exit 3; }');
    expect(p[4]).toBe(`HELPER_FLAGS='${HELPER_FLAGS}'`);
    expect(p[5]).toBe('mcr() { timeout "${MCT:-120}" docker run --rm -i $HELPER_FLAGS --entrypoint mc "$IMG" "$@"; }');
    expect(p[6]).toBe(`out() { printf 'TUGRA_OBJ_OUT %s %s\\n' "$1" "$(head -c 65536 | base64 | tr -d '\\n')"; }`);
  });
  it("the helper flags drop every capability, forbid new privileges, are read-only, noexec tmpfs, bounded and pull-never", () => {
    expect(HELPER_FLAGS).toBe(
      "--pull never --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m --pids-limit 256 --memory 1g --add-host host.docker.internal:host-gateway -e HOME=/tmp -e MC_HOST_src -e MC_HOST_dst",
    );
    expect(HELPER_FLAGS).not.toMatch(/docker\.sock|--privileged|--network host|--net host|-v |--volume|--mount|--env-file/);
  });
  it("credentials appear ONLY in the two export lines (never argv), and survive shq for every nasty character", () => {
    const script = buildObjProbeScript(sides);
    const body = script.split("\n").filter((l) => !l.startsWith("export MC_HOST_"));
    for (const secret of [SECRET_PW, "SRC'AK", "DST$AK", "d`st", "encodeURIComponent"]) expect(body.join("\n")).not.toContain(secret);
    expect(body.join("\n")).not.toMatch(/MC_HOST_(src|dst)=/);
    const exp = script.split("\n").filter((l) => l.startsWith("export MC_HOST_"));
    expect(exp).toHaveLength(2);
    expect(bashSyntax(script)).toEqual({ status: 0, stderr: "" });
  });
  it("the export round-trips through bash: the env value equals the userinfo-encoded URL for creds with ' ! ~ $ ` \\ ; & |", () => {
    const r = spawnSync("bash", ["-c", `${objPrelude(sides).split("\n").filter((l) => l.startsWith("export MC_HOST_")).join("\n")}\nprintf '%s\\n%s' "$MC_HOST_src" "$MC_HOST_dst"`], { encoding: "utf8" });
    expect(r.status).toBe(0);
    const [src, dst] = r.stdout.split("\n");
    const u = new URL(src);
    expect(decodeURIComponent(u.password)).toBe(SECRET_PW);
    expect(u.host).toBe("src.example.com:9000");
    expect(new URL(dst).host).toBe("host.docker.internal:9100");
    expect(src.startsWith("https://")).toBe(true);
  });
  it("refuses a scheme-less endpoint (no implicit https)", () => {
    expect(() => objPrelude({ ...sides, src: { ...sides.src, endpoint: "src.example.com" } })).toThrow(/http/);
  });
});

describe("builders: golden strings + hostile input", () => {
  it("start script (seed, 1 bucket) golden", () => {
    const s = buildObjStartScript(sides, { id: ID, phase: "seed", remove: false, preserve: true, buckets: [{ idx: 3, src: "bk1", dst: "bk1-new", exclude: ["tmp/*", "*.log"] }] });
    const tail = s.split("\n").slice(7);
    expect(tail).toEqual([
      `docker rm -f tugra-objmig-${ID}-3 >/dev/null 2>&1 || true`,
      `CID=$(docker run -d --name tugra-objmig-${ID}-3 --label tugra.role=objmig --label tugra.objmig=${ID} --label tugra.objmig.idx=3 \\`,
      `  $HELPER_FLAGS --log-driver json-file --log-opt max-size=10m --log-opt max-file=2 --entrypoint mc "$IMG" \\`,
      `  mirror --json --preserve --exclude 'tmp/*' --exclude '*.log' 'src/bk1' 'dst/bk1-new') \\`,
      `  && printf 'TUGRA_OBJ_STARTED %s %.12s\\n' 3 "$CID" || echo "TUGRA_OBJ_ERR 3 run-failed"`,
      "echo TUGRA_OBJ_START_END",
    ]);
  });

  it("--overwrite and --remove appear ONLY in the right phase; no --include ever", () => {
    const mk = (phase: "seed" | "final", remove: boolean, preserve = true) => buildObjStartScript(sides, { id: ID, phase, remove, preserve, buckets: [{ idx: 0, src: "bk1", dst: "bk1", exclude: [] }] });
    expect(mk("seed", false)).not.toMatch(/--overwrite|--remove/);
    expect(mk("seed", true)).not.toMatch(/--overwrite|--remove/); // remove is ignored in a seed
    const fin = mk("final", false);
    expect(fin).toContain("--overwrite");
    expect(fin).not.toContain("--remove");
    expect(mk("final", true)).toMatch(/--overwrite --remove/);
    expect(mk("seed", false, false)).not.toContain("--preserve");
    for (const phase of ["seed", "final"] as const) expect(mk(phase, true)).not.toContain("--include");
  });

  it("EVERY docker run carries the hardening flags (via $HELPER_FLAGS) and no socket/host mount", () => {
    const scripts = [
      buildObjProbeScript(sides),
      buildObjDuScript(sides, [{ src: "bk1", dst: "bk1", dstExists: true }]),
      buildObjStartScript(sides, { id: ID, phase: "final", remove: true, preserve: true, buckets: [{ idx: 0, src: "bk1", dst: "bk1", exclude: [] }] }),
      buildObjDiffScript(sides, [{ src: "bk1", dst: "bk1" }]),
      buildObjConfigApplyScript(sides, [{ dst: "bk1", policy: "{}", ilm: "{}", tags: [["a", "b"]] }]),
    ];
    for (const s of scripts) {
      // every `docker run ...` (up to its --entrypoint, across the line continuation) carries the shared hardening flags
      const runs = s.match(/docker run[\s\S]*?--entrypoint/g) ?? [];
      expect(runs.length).toBeGreaterThan(0);
      for (const l of runs) expect(l).toContain("$HELPER_FLAGS");
      expect(s).not.toMatch(/docker\.sock|--privileged|--network|-v \/|--volume|--mount/);
    }
  });

  it("hostile bucket / glob / id / idx / tag / endpoint are rejected BEFORE a script exists", () => {
    const base = { id: ID, phase: "seed" as const, remove: false, preserve: true };
    for (const bad of ["BK", "a", "-bad", "bk;rm -rf /", "bk$(id)", "bk\nx", "bk b", "bk'x", "../etc", "b".repeat(64)]) {
      expect(() => buildObjStartScript(sides, { ...base, buckets: [{ idx: 0, src: bad, dst: "ok-bucket", exclude: [] }] })).toThrow(/bucket/);
      expect(() => buildObjStartScript(sides, { ...base, buckets: [{ idx: 0, src: "ok-bucket", dst: bad, exclude: [] }] })).toThrow(/bucket/);
      expect(() => buildObjDuScript(sides, [{ src: bad, dst: "ok-bucket", dstExists: false }])).toThrow();
      expect(() => buildObjDiffScript(sides, [{ src: "ok-bucket", dst: bad }])).toThrow();
    }
    for (const g of ["a;b", "$(id)", "a`b`", "../x", "a|b", "a'b", "a\nb", "x&y", ""]) {
      expect(() => buildObjStartScript(sides, { ...base, buckets: [{ idx: 0, src: "bk1", dst: "bk1", exclude: [g] }] })).toThrow(/glob/);
    }
    for (const id of ["short", "UPPERCASEUPPERCASEUPPERCASE", "a;b", `${ID}$(id)`, "x".repeat(40)]) {
      expect(() => buildObjStartScript(sides, { ...base, id, buckets: [] })).toThrow(/id/);
      expect(() => buildObjStatusScript({ id, idxs: [0] })).toThrow(/id/);
      expect(() => buildObjCleanupScript(id)).toThrow(/id/);
    }
    for (const idx of [-1, 1.5, NaN, 1e9]) {
      expect(() => buildObjStartScript(sides, { ...base, buckets: [{ idx, src: "bk1", dst: "bk1", exclude: [] }] })).toThrow(/index/);
      expect(() => buildObjStatusScript({ id: ID, idxs: [idx] })).toThrow(/index/);
    }
    expect(() => buildObjConfigApplyScript(sides, [{ dst: "bk1", tags: [["k;x", "v"]] }])).toThrow(/tag/);
    expect(() => buildObjConfigApplyScript(sides, [{ dst: "bk1", tags: [["k", "a&b=c"]] }])).toThrow(/tag/);
    expect(() => objPrelude({ ...sides, dst: { ...sides.dst, endpoint: "ftp://x" } })).toThrow();
  });

  it("status + cleanup scripts need no credentials and list only the requested helpers", () => {
    const st = buildObjStatusScript({ id: ID, idxs: [0, 2] });
    expect(st).not.toMatch(/MC_HOST|TUGRA_AGENT_IMAGE/);
    expect(st).toContain(`docker inspect -f '{{.State.Status}} {{.State.ExitCode}}' tugra-objmig-${ID}-2`);
    expect(st).not.toContain(`-1\n`);
    expect(buildObjCleanupScript(ID)).toBe(`set -u\ndocker ps -aq --filter label=tugra.objmig=${ID} | xargs -r docker rm -f >/dev/null 2>&1 || true\necho TUGRA_OBJ_CLEAN_END`);
    expect(buildObjCleanupScript(ID, 4)).toContain(`--filter label=tugra.objmig.idx=4`);
  });

  it("bash -n accepts every builder", () => {
    const scripts = [
      buildObjProbeScript(sides),
      buildObjDuScript(sides, [{ src: "bk1", dst: "bk1", dstExists: true }, { src: "bk2", dst: "bk2-x", dstExists: false }]),
      buildObjStartScript(sides, { id: ID, phase: "final", remove: true, preserve: true, buckets: [{ idx: 0, src: "bk1", dst: "bk1", exclude: ["a b/*"] }, { idx: 1, src: "bk2", dst: "bk2", exclude: [] }] }),
      buildObjStatusScript({ id: ID, idxs: [0, 1] }),
      buildObjDiffScript(sides, [{ src: "bk1", dst: "bk1" }]),
      buildObjConfigApplyScript(sides, [{ dst: "bk1", policy: MC_POLICY_JSON, ilm: MC_ILM_JSON, tags: [["env", "prod"], ["team", "web"]] }]),
      buildObjCleanupScript(ID),
      buildObjCleanupScript(ID, 1),
    ];
    for (const s of scripts) expect(bashSyntax(s)).toEqual({ status: 0, stderr: "" });
  });

  it("config apply carries the payload as base64 on stdin, never argv", () => {
    const s = buildObjConfigApplyScript(sides, [{ dst: "bk1", policy: '{"a":"it\'s"}' }]);
    expect(s).not.toContain("it's");
    expect(s).toContain("| base64 -d | MCT=60 mcr anonymous set-json /dev/stdin 'dst/bk1'");
  });
});

// ── shell lab: the REAL scripts against a fake docker ────────────────────────────────────────────────────────────
describe("shell lab (fake docker shim)", () => {
  let lab: string;
  const FAKE_DOCKER = `#!/bin/bash
echo "$*" >> "$LAB/docker.log"
cmd="$1"; shift
case "$cmd" in
  run)
    detached=0; name=""; args=("$@"); n=\${#args[@]}
    for ((i=0;i<n;i++)); do
      case "\${args[i]}" in -d) detached=1;; --name) name="\${args[i+1]}";; esac
    done
    idx=-1; for ((i=0;i<n;i++)); do if [ "\${args[i]}" = "--entrypoint" ]; then idx=$((i+3)); break; fi; done
    [ "$idx" -ge 0 ] || exit 125
    mc=("\${args[@]:$idx}")
    if [ "$detached" = 1 ]; then
      [ -n "$FAIL_START" ] && exit 125
      echo "running 0" > "$LAB/state-$name"; echo "0123456789abcdef0123"; exit 0
    fi
    case "\${mc[0]}" in
      --version) [ -n "$NO_MC" ] && exit 1; echo "mc version RELEASE.2025-08-13T08-35-41Z (commit-id=x)";;
      ls) case "\${mc[2]}" in src) [ -n "$SRC_DOWN" ] && exit 1; cat "$LAB/ls-src.json";; dst) cat "$LAB/ls-dst.json";; esac;;
      du) cat "$LAB/du.json";;
      diff) cat "$LAB/diff.json"; exit "\${DIFF_RC:-0}";;
      version) echo '${MC_VERSION_INFO_ENABLED}';;
      anonymous) echo '${MC_POLICY_JSON}';;
      ilm) echo '${MC_ILM_JSON}';;
      tag) echo '${MC_TAGS_JSON}';;
    esac;;
  inspect) f="$LAB/state-\${@: -1}"; [ -f "$f" ] && cat "$f" || exit 1;;
  logs) cat "$LAB/logs.txt";;
  rm) shift; n="\${@: -1}"; rm -f "$LAB/state-$n"; echo removed;;
  ps) echo "cid1"; echo "cid2";;
esac
exit 0
`;
  beforeAll(() => {
    lab = mkdtempSync(join(tmpdir(), "objlab-"));
    const bin = join(lab, "bin");
    mkdirSync(bin);
    const put = (name: string, body: string) => {
      writeFileSync(join(bin, name), body);
      chmodSync(join(bin, name), 0o755);
    };
    put("docker", FAKE_DOCKER);
    put("timeout", "#!/bin/bash\nshift\nexec \"$@\"\n");
    put("date", "#!/bin/bash\necho 1000\n");
    put("xargs", '#!/bin/bash\n[ "$1" = "-r" ] && shift\nwhile read -r a; do "$@" "$a"; done\n');
  });
  afterAll(() => rmSync(lab, { recursive: true, force: true }));
  beforeEach(() => {
    writeFileSync(join(lab, "docker.log"), "");
    writeFileSync(join(lab, "ls-src.json"), MC_LS_JSON);
    writeFileSync(join(lab, "ls-dst.json"), '{"status":"success","type":"folder","key":"bk1/"}');
    writeFileSync(join(lab, "du.json"), MC_DU_JSON);
    writeFileSync(join(lab, "diff.json"), MC_DIFF_JSON);
    writeFileSync(join(lab, "logs.txt"), MC_MIRROR_OUT_OF_ORDER_JSON);
  });

  const run = (script: string, env: Record<string, string> = {}) =>
    spawnSync("bash", ["-c", script], { encoding: "utf8", env: { PATH: `${join(lab, "bin")}:${process.env.PATH}`, LAB: lab, TUGRA_AGENT_IMAGE: "tugra-agent:test", HOME: lab, ...env } });
  const dockerLog = () => readFileSync(join(lab, "docker.log"), "utf8");

  it("probe: prints the version, reachability for both sides, bucket listings and the END marker", () => {
    const r = run(buildObjProbeScript(sides));
    expect(r.status).toBe(0);
    const p = parseProbe(r.stdout);
    expect(p).toMatchObject({ complete: true, protocol: true, tool: { present: true, version: "RELEASE.2025-08-13T08-35-41Z" }, reach: { src: { ok: true }, dst: { ok: true } }, srcBuckets: ["bk1", "bk2"], dstBuckets: ["bk1"] });
    // creds are in the helper's ENV by name only: nothing secret ever reached docker's argv
    expect(dockerLog()).not.toContain(SECRET_PW);
    expect(dockerLog()).not.toContain("SRC'AK");
    expect(dockerLog()).toContain("-e MC_HOST_src");
  });

  it("probe: an unreachable source, a missing mc and a missing agent image are reported (fail closed)", () => {
    expect(parseProbe(run(buildObjProbeScript(sides), { SRC_DOWN: "1" }).stdout).reach.src?.ok).toBe(false);
    const noMc = parseProbe(run(buildObjProbeScript(sides), { NO_MC: "1" }).stdout);
    expect(noMc.tool).toEqual({ present: false });
    expect(noMc.complete).toBe(true);
    const noImg = run(buildObjProbeScript(sides), { TUGRA_AGENT_IMAGE: "" });
    expect(noImg.status).toBe(3);
    expect(parseProbe(noImg.stdout)).toMatchObject({ noAgentImage: true, complete: false });
  });

  it("du: per-bucket sizes, versioning and config export parse end-to-end", () => {
    const r = run(buildObjDuScript(sides, [{ src: "bk1", dst: "bk1", dstExists: true }]));
    expect(r.status).toBe(0);
    const du = parseDuOutput(r.stdout).get("bk1")!;
    expect(du.src).toEqual({ objects: 2, bytes: 12 });
    expect(du.dst).toEqual({ objects: 2, bytes: 12 });
    expect(du.versioning).toBe("enabled");
    expect(du.config.policy).toBeDefined();
    expect(du.config.tags).toEqual([["env", "prod"], ["team", "web"]]);
    expect(r.stdout).toContain("TUGRA_OBJ_DU_END");
  });

  it("start: one detached helper per bucket with the labels, then the STARTED markers; a docker failure => run-failed", () => {
    const ok = run(buildObjStartScript(sides, { id: ID, phase: "seed", remove: false, preserve: true, buckets: [{ idx: 0, src: "bk1", dst: "bk1", exclude: [] }, { idx: 1, src: "bk2", dst: "bk2", exclude: ["*.tmp"] }] }));
    const s = parseStarted(ok.stdout);
    expect([...s.started.keys()]).toEqual([0, 1]);
    expect(s.complete).toBe(true);
    const log = dockerLog();
    expect(log).toContain(`--name tugra-objmig-${ID}-0`);
    expect(log).toContain(`--label tugra.objmig=${ID}`);
    expect(log).toContain("mirror --json --preserve --exclude *.tmp src/bk2 dst/bk2");
    const bad = parseStarted(run(buildObjStartScript(sides, { id: ID, phase: "seed", remove: false, preserve: true, buckets: [{ idx: 0, src: "bk1", dst: "bk1", exclude: [] }] }), { FAIL_START: "1" }).stdout);
    expect([...bad.failed]).toEqual([0]);
    expect(bad.started.size).toBe(0);
  });

  it("status: running state, progress = the MAX cumulative totals (mc prints them out of order), errors counted; exited => exit code", () => {
    run(buildObjStartScript(sides, { id: ID, phase: "seed", remove: false, preserve: true, buckets: [{ idx: 0, src: "bk1", dst: "bk1", exclude: [] }] }));
    const running = parseStatus(run(buildObjStatusScript({ id: ID, idxs: [0] })).stdout)!;
    expect(running.get(0)).toMatchObject({ state: "running", exitCode: 0, errors: 0, doneObjects: 3, doneBytes: 5014 });
    writeFileSync(join(lab, `state-tugra-objmig-${ID}-0`), "exited 1");
    writeFileSync(join(lab, "logs.txt"), `${MC_MIRROR_JSON}\n{"status":"error","error":{"message":"Access Denied."}}`);
    const failed = parseStatus(run(buildObjStatusScript({ id: ID, idxs: [0] })).stdout)!;
    expect(failed.get(0)).toMatchObject({ state: "exited", exitCode: 1, errors: 1 });
    expect(failed.get(0)!.last).toContain("Access Denied");
    // an absent helper
    const absent = parseStatus(run(buildObjStatusScript({ id: ID, idxs: [7] })).stdout)!;
    expect(absent.get(7)).toMatchObject({ state: "absent" });
  });

  it("diff: counts are tallied in the script (no object key leaves the host) from the REAL numeric mc diff output", () => {
    const r = run(buildObjDiffScript(sides, [{ src: "bk1", dst: "bk1" }]));
    expect(r.stdout).not.toMatch(/extra\.txt|new\.txt|one\.txt|blob\.bin/);
    const d = parseDiff(r.stdout);
    expect(d.complete).toBe(true);
    expect(d.rows.get("bk1")).toEqual({ bucket: "bk1", missing: 2, differ: 1, extra: 1, errors: 0, rc: 0 });
  });

  it("diff: a clean diff reports zeros; error lines and non-JSON noise count as errors; the mc exit code is carried", () => {
    writeFileSync(join(lab, "diff.json"), "");
    expect(parseDiff(run(buildObjDiffScript(sides, [{ src: "bk1", dst: "bk1" }])).stdout).rows.get("bk1")).toMatchObject({ missing: 0, differ: 0, extra: 0, errors: 0, rc: 0 });
    writeFileSync(join(lab, "diff.json"), '{"status":"error","error":{"message":"boom"}}\nmc: <ERROR> trouble');
    expect(parseDiff(run(buildObjDiffScript(sides, [{ src: "bk1", dst: "bk1" }]), { DIFF_RC: "1" }).stdout).rows.get("bk1")).toMatchObject({ errors: 2, rc: 1 });
  });

  it("config apply: ok markers per item", () => {
    const r = run(buildObjConfigApplyScript(sides, [{ dst: "bk1", policy: MC_POLICY_JSON, ilm: MC_ILM_JSON, tags: [["env", "prod"]] }]));
    const c = parseCfgResults(r.stdout);
    expect(c.complete).toBe(true);
    expect(c.results.map((x) => `${x.kind}:${x.ok}`).sort()).toEqual(["ilm:true", "policy:true", "tag:true"]);
  });

  it("cleanup: removes the labelled helpers and ends with its marker", () => {
    const r = run(buildObjCleanupScript(ID));
    expect(r.stdout).toContain("TUGRA_OBJ_CLEAN_END");
    expect(dockerLog()).toContain("rm -f cid1");
  });
});
