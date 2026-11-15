import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DOCKER_NAME_RE,
  MOVE_STAGING_ROOT,
  MOVE_TIMEOUTS,
  assertDockerName,
  assertIdx,
  assertMoveId,
  assertPart,
  buildMoveApplyScript,
  buildMoveArchivePurgeScript,
  buildMoveCleanupScript,
  buildMovePackScript,
  buildMovePartStatScript,
  buildMovePrepareScript,
  buildMoveProbeScript,
  buildMoveRecvScript,
  buildMoveSendScript,
  buildMoveSourcePartDropScript,
  isValidDockerName,
  moveDir,
  parseMoveApplyOk,
  parseMovePacked,
  parseMovePart,
  parseMovePrepare,
  parseMoveProbe,
  partName,
  probeHostPathKey,
  scrubMoveOutput,
  shq,
  volDir,
} from "./app-move-scripts";
import { BACKUP_HELPER_IMAGE } from "../volume-backups/volume-backup-script";
import { mintRelayPath } from "./volume-relay-sig";

const MOVE_ID = "ckmoveabcdefghijklmnopqrs"; // 25 chars, cuid-shaped

describe("name / id validation", () => {
  it("accepts real docker volume names and rejects anything shell-hostile", () => {
    for (const ok of ["tugra_appv_cabc123_data", "tugra_cabc123_db-data", "a", "A9._-x"]) expect(isValidDockerName(ok)).toBe(true);
    for (const bad of ["", "-rf", ".hidden", "a b", "a;b", "a$(id)", "a`id`", "a\nb", "a/../b", "../x", "a'b", 'a"b', "a|b", "a".repeat(129), "ünï"]) {
      expect(isValidDockerName(bad)).toBe(false);
      expect(() => assertDockerName(bad)).toThrow(/invalid docker volume name/);
    }
    expect(DOCKER_NAME_RE.test("tugra_appv_x_y")).toBe(true);
  });

  it("validates move ids, volume indexes and part numbers", () => {
    expect(assertMoveId(MOVE_ID)).toBe(MOVE_ID);
    for (const bad of ["", "short", "UPPERCASE0000000000000000", "ck/../../etc0000000000000", "ck;rm -rf /000000000000", "x".repeat(40)]) {
      expect(() => assertMoveId(bad)).toThrow(/invalid move id/);
    }
    expect(assertIdx(0)).toBe(0);
    expect(assertIdx(999)).toBe(999);
    for (const bad of [-1, 1000, 1.5, NaN]) expect(() => assertIdx(bad)).toThrow(/invalid volume index/);
    expect(assertPart(99_999)).toBe(99_999);
    for (const bad of [-1, 100_000, 0.5]) expect(() => assertPart(bad)).toThrow(/invalid part number/);
  });

  it("derives staging paths from validated parts only", () => {
    expect(moveDir(MOVE_ID)).toBe(`${MOVE_STAGING_ROOT}/${MOVE_ID}`);
    expect(volDir(MOVE_ID, 3)).toBe(`${MOVE_STAGING_ROOT}/${MOVE_ID}/3`);
    expect(partName(0)).toBe("p.00000");
    expect(partName(42)).toBe("p.00042");
    expect(() => volDir("../x", 0)).toThrow();
  });

  it("shq quotes single quotes safely", () => {
    expect(shq("a'b")).toBe(`'a'\\''b'`);
  });
});

describe("buildMoveProbeScript", () => {
  it("is read-only: no mkdir, no pull, no rm, no write redirection to a file", () => {
    const s = buildMoveProbeScript({ dockerVolumes: ["tugra_appv_a1_data"], hostPaths: ["/mnt/media"] });
    expect(s).not.toMatch(/mkdir|docker pull|(^|\s)rm\s|docker volume (create|rm)|>\s*\/(etc|var|tmp)/);
    expect(s).toContain("--pull=never"); // sizing must never fetch an image
    expect(s.endsWith("echo TUGRA_PROBE_END")).toBe(true);
  });

  it("golden: the fixed template with one volume and one host path", () => {
    const s = buildMoveProbeScript({ dockerVolumes: ["tugra_appv_a1_data"], hostPaths: ["/mnt/media"] });
    expect(s).toContain("probe_df /var/lib/docker\nprobe_df /etc/tugra/app-moves\n");
    expect(s).toContain(`echo "TUGRA_VOL tugra_appv_a1_data EXISTS \${kb:--} \${lb:--}"`);
    expect(s).toContain(`echo "TUGRA_VOL tugra_appv_a1_data ABSENT"`);
    expect(s).toContain(`if [ -e '/mnt/media' ]; then echo "TUGRA_HOSTPATH /mnt/media 1"; else echo "TUGRA_HOSTPATH /mnt/media 0"; fi`);
    expect(s).toContain("ss -ltnH");
    expect(s).toContain("netstat -ltn");
  });

  it("rejects a hostile volume name or host path before building anything", () => {
    for (const bad of ["a;b", "$(id)", "-x", "a\nb", "../x"]) expect(() => buildMoveProbeScript({ dockerVolumes: [bad] })).toThrow();
    for (const bad of ["relative/path", "/ok\n/bad", ""]) expect(() => buildMoveProbeScript({ dockerVolumes: [], hostPaths: [bad] })).toThrow(/invalid host path/);
  });

  it("marker-safe host path keys", () => {
    expect(probeHostPathKey("/mnt/my media")).toBe("/mnt/my_media");
  });
});

const GOOD = [
  "TUGRA_DF /var/lib/docker 40000000 2049",
  "TUGRA_DF /etc/tugra/app-moves 40000000 2049",
  "TUGRA_TOOL curl 1",
  "TUGRA_TOOL split 1",
  "TUGRA_TOOL sha256sum 1",
  "TUGRA_TOOL gzip 1",
  "TUGRA_TOOL helper 0",
  "TUGRA_VOL tugra_appv_a1_data EXISTS 2048 -",
  "TUGRA_VOL tugra_appv_a1_cache ABSENT",
  "TUGRA_PORT 22",
  "TUGRA_PORT 20001",
  "TUGRA_HOSTPATH /mnt/media 1",
  "TUGRA_PROBE_END",
];
const EXPECT = { dockerVolumes: ["tugra_appv_a1_data", "tugra_appv_a1_cache"], hostPaths: ["/mnt/media"] };
const join_ = (lines: string[]) => lines.join("\n") + "\n";

describe("parseMoveProbe — strict", () => {
  it("parses a complete, well-formed probe", () => {
    const p = parseMoveProbe(`noise before\n${join_(GOOD)}`, EXPECT)!;
    expect(p.df["/var/lib/docker"]).toEqual({ availKb: 40000000, dev: "2049" });
    expect(p.tools).toEqual({ curl: true, split: true, sha256sum: true, gzip: true, helper: false });
    expect(p.vols.tugra_appv_a1_data).toEqual({ exists: true, kb: 2048, label: null });
    expect(p.vols.tugra_appv_a1_cache).toEqual({ exists: false, kb: null, label: null });
    expect([...p.ports].sort((a, b) => a - b)).toEqual([22, 20001]);
    expect(p.hostPaths["/mnt/media"]).toBe(true);
  });

  it("keeps a move label and unknown sizes/devices as nulls", () => {
    const lines = GOOD.map((l) => (l.startsWith("TUGRA_VOL tugra_appv_a1_data") ? "TUGRA_VOL tugra_appv_a1_data EXISTS - ck123" : l.replace("40000000 2049", "- -")));
    const p = parseMoveProbe(join_(lines), EXPECT)!;
    expect(p.vols.tugra_appv_a1_data).toEqual({ exists: true, kb: null, label: "ck123" });
    expect(p.df["/var/lib/docker"]).toEqual({ availKb: null, dev: null });
  });

  it("fails closed (null) when the end marker is missing (truncated output)", () => {
    expect(parseMoveProbe(join_(GOOD.slice(0, -1)), EXPECT)).toBeNull();
  });

  it.each([
    ["a required df line is missing", (l: string[]) => l.filter((x) => !x.startsWith("TUGRA_DF /etc/tugra"))],
    ["a tool line is missing", (l: string[]) => l.filter((x) => x !== "TUGRA_TOOL gzip 1")],
    ["a volume line is missing", (l: string[]) => l.filter((x) => !x.includes("a1_cache"))],
    ["a host path line is missing", (l: string[]) => l.filter((x) => !x.startsWith("TUGRA_HOSTPATH"))],
    ["a df line is malformed", (l: string[]) => l.map((x) => (x.startsWith("TUGRA_DF /var") ? "TUGRA_DF /var/lib/docker lots 1" : x))],
    ["a tool flag is not 0/1", (l: string[]) => l.map((x) => (x === "TUGRA_TOOL curl 1" ? "TUGRA_TOOL curl yes" : x))],
    ["a volume marker has extra fields", (l: string[]) => l.map((x) => (x.includes("a1_data") ? "TUGRA_VOL tugra_appv_a1_data EXISTS 1 - extra" : x))],
    ["a volume the caller did not ask for appears", (l: string[]) => ["TUGRA_VOL surprise ABSENT", ...l]],
    ["a volume is reported twice", (l: string[]) => ["TUGRA_VOL tugra_appv_a1_cache ABSENT", ...l]],
    ["a port is out of range", (l: string[]) => ["TUGRA_PORT 70000", ...l]],
    ["an unknown TUGRA_ marker appears", (l: string[]) => ["TUGRA_WHAT 1", ...l]],
    ["a marker follows the end marker", (l: string[]) => [...l, "TUGRA_PORT 1"]],
    ["a tool is reported twice", (l: string[]) => ["TUGRA_TOOL curl 0", ...l]],
  ])("fails closed when %s", (_name, mutate) => {
    expect(parseMoveProbe(join_(mutate(GOOD)), EXPECT)).toBeNull();
  });

  it("ignores non-marker noise lines", () => {
    expect(parseMoveProbe("warning: something\n" + join_(GOOD) + "trailing log\n".replace("trailing log\n", ""), EXPECT)).not.toBeNull();
  });
});

describe("probe script, executed against stubbed tools (shell semantics)", () => {
  // The probe is plain POSIX-ish shell; run the REAL script with stub `docker`/`stat`/`ss` on PATH so the markers it
  // prints (and our parser's view of them) are verified end to end without a docker host.
  const dir = mkdtempSync(join(tmpdir(), "tugra-probe-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const stub = (name: string, body: string) => {
    writeFileSync(join(dir, name), `#!/bin/bash\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  };
  stub(
    "docker",
    `case "$1 $2" in
  "image inspect") exit 1 ;;
  "volume inspect")
    if [ "$3" = "-f" ]; then
      case "$4" in *Labels*) echo "ckmovelabel"; exit 0;; *Mountpoint*) echo "/nonexistent-mp"; exit 0;; esac
    fi
    [ "$3" = "tugra_appv_a1_data" ] && exit 0 || exit 1 ;;
  "run --rm") echo "2048	/d"; exit 0 ;;
esac
exit 1`,
  );
  stub("stat", `echo 2049`);
  stub("ss", `printf 'LISTEN 0 4096 0.0.0.0:22 0.0.0.0:*\\nLISTEN 0 4096 [::]:20001 [::]:*\\nLISTEN 0 4096 127.0.0.53%%lo:53 0.0.0.0:*\\n'`);

  it("prints markers our strict parser accepts, with the right sizes/labels/ports", () => {
    const script = buildMoveProbeScript({ dockerVolumes: ["tugra_appv_a1_data", "tugra_appv_a1_cache"], hostPaths: ["/definitely/not/here"] });
    const out = execFileSync("bash", ["-c", script], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: "utf8" });
    const p = parseMoveProbe(out, { dockerVolumes: ["tugra_appv_a1_data", "tugra_appv_a1_cache"], hostPaths: ["/definitely/not/here"] });
    expect(p).not.toBeNull();
    expect(p!.vols.tugra_appv_a1_data).toEqual({ exists: true, kb: 2048, label: "ckmovelabel" });
    expect(p!.vols.tugra_appv_a1_cache.exists).toBe(false);
    expect(p!.tools.helper).toBe(false);
    expect([...p!.ports].sort((a, b) => a - b)).toEqual([22, 53, 20001]);
    expect(p!.hostPaths["/definitely/not/here"]).toBe(false);
    expect(p!.df["/var/lib/docker"].dev).toBe("2049");
  });
});


// ───────────────────────────── transfer script builders: goldens + hostile input ─────────────────────────────

const IMG = BACKUP_HELPER_IMAGE;
const D0 = `${MOVE_STAGING_ROOT}/${MOVE_ID}/0`;
const RELAY = mintRelayPath("secret-0123456789", { id: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", role: "src", serverId: "s1", moveId: MOVE_ID, volIdx: 0, part: 7, size: 1000, sha256: "a".repeat(64) }, 1_900_000_000);
const SHA = "b".repeat(64);

describe("buildMovePrepareScript", () => {
  it("golden: staging dir, helper image, labelled create-if-missing per volume (compose labels only for compose volumes)", () => {
    expect(buildMovePrepareScript(MOVE_ID, [{ dockerName: "tugra_appv_capp_data" }, { dockerName: "tugra_capp_db", compose: { project: "tugra_capp", key: "db" } }])).toBe(
      [
        "set -e",
        "umask 077",
        `mkdir -p -m 700 ${MOVE_STAGING_ROOT}/${MOVE_ID}`,
        `docker image inspect ${IMG} >/dev/null 2>&1 || docker pull ${IMG}`,
        `if docker volume inspect 'tugra_appv_capp_data' >/dev/null 2>&1; then echo "TUGRA_VX_CREATED tugra_appv_capp_data 0"; else docker volume create --label tugra.move=${MOVE_ID} 'tugra_appv_capp_data' >/dev/null; echo "TUGRA_VX_CREATED tugra_appv_capp_data 1"; fi`,
        `if docker volume inspect 'tugra_capp_db' >/dev/null 2>&1; then echo "TUGRA_VX_CREATED tugra_capp_db 0"; else docker volume create --label tugra.move=${MOVE_ID} --label com.docker.compose.project=tugra_capp --label com.docker.compose.volume=db 'tugra_capp_db' >/dev/null; echo "TUGRA_VX_CREATED tugra_capp_db 1"; fi`,
      ].join("\n"),
    );
  });

  it("rejects hostile docker names, compose labels and move ids", () => {
    for (const bad of ["a;b", "$(id)", "-x", "a\nb", "../x"]) expect(() => buildMovePrepareScript(MOVE_ID, [{ dockerName: bad }])).toThrow();
    expect(() => buildMovePrepareScript(MOVE_ID, [{ dockerName: "ok", compose: { project: "p;x", key: "k" } }])).toThrow();
    expect(() => buildMovePrepareScript(MOVE_ID, [{ dockerName: "ok", compose: { project: "p", key: "k\nx" } }])).toThrow();
    expect(() => buildMovePrepareScript("../../etc", [{ dockerName: "ok" }])).toThrow();
  });

  it("parseMovePrepare is strict: every volume exactly once, nothing unknown, 0/1 only", () => {
    expect(parseMovePrepare("TUGRA_VX_CREATED a 1\nTUGRA_VX_CREATED b 0\n", ["a", "b"])).toEqual({ a: true, b: false });
    expect(parseMovePrepare("TUGRA_VX_CREATED a 1\n", ["a", "b"])).toBeNull(); // missing
    expect(parseMovePrepare("TUGRA_VX_CREATED a 1\nTUGRA_VX_CREATED a 0\n", ["a"])).toBeNull(); // duplicate
    expect(parseMovePrepare("TUGRA_VX_CREATED a 2\n", ["a"])).toBeNull();
    expect(parseMovePrepare("TUGRA_VX_CREATED z 1\n", ["a"])).toBeNull(); // unknown volume
    expect(parseMovePrepare("TUGRA_VX_CREATED a 1 extra\n", ["a"])).toBeNull();
  });
});

describe("buildMovePackScript", () => {
  it("golden", () => {
    expect(buildMovePackScript({ moveId: MOVE_ID, idx: 0, dockerVolume: "tugra_appv_capp_data", partBytes: 268435456 })).toBe(
      [
        "set -e",
        "set -o pipefail",
        `D=${D0}`,
        'umask 077; rm -rf "$D"; mkdir -p "$D"',
        `docker run --rm -v 'tugra_appv_capp_data':/data:ro ${IMG} tar -C /data -cf - . | gzip -1 | split -b 268435456 -d -a 5 - "$D/p."`,
        `N=$(ls "$D" | grep -c '^p\\.' || true)`,
        '[ "$N" -ge 1 ] || { echo "empty pack" >&2; exit 67; }',
        '( cd "$D" && sha256sum p.* > sums )',
        `E=$(docker run --rm -v 'tugra_appv_capp_data':/data:ro ${IMG} sh -c 'find /data -mindepth 1 | wc -l | tr -d " "')`,
        'echo "TUGRA_VX_PACKED parts=$N entries=$E"',
      ].join("\n"),
    );
  });

  it("mounts the volume read-only and never relays or touches the network", () => {
    const s = buildMovePackScript({ moveId: MOVE_ID, idx: 2, dockerVolume: "v", partBytes: 4096 });
    expect(s).toContain("/data:ro");
    expect(s).not.toMatch(/curl|TUGRA_HUB_ORIGIN|agent-vx/);
  });

  it("validates volume name, index, move id and part size", () => {
    expect(() => buildMovePackScript({ moveId: MOVE_ID, idx: 0, dockerVolume: "a;b", partBytes: 4096 })).toThrow();
    expect(() => buildMovePackScript({ moveId: MOVE_ID, idx: 1000, dockerVolume: "v", partBytes: 4096 })).toThrow();
    expect(() => buildMovePackScript({ moveId: "bad", idx: 0, dockerVolume: "v", partBytes: 4096 })).toThrow();
    for (const partBytes of [0, 1023, 2 * 1024 ** 3 + 1, 1.5, NaN]) expect(() => buildMovePackScript({ moveId: MOVE_ID, idx: 0, dockerVolume: "v", partBytes })).toThrow();
  });

  it("parseMovePacked is strict", () => {
    expect(parseMovePacked("noise\nTUGRA_VX_PACKED parts=3 entries=12\n")).toEqual({ parts: 3, entries: 12 });
    expect(parseMovePacked("TUGRA_VX_PACKED parts=3 entries=0\n")).toEqual({ parts: 3, entries: 0 });
    for (const bad of ["", "TUGRA_VX_PACKED parts=0 entries=1", "TUGRA_VX_PACKED parts=3", "TUGRA_VX_PACKED parts=3 entries=1 x", "TUGRA_VX_PACKED parts=-1 entries=1", "TUGRA_VX_PACKED parts=3 entries=1\nTUGRA_VX_PACKED parts=3 entries=1", "TUGRA_VX_PACKED parts=999999 entries=1"]) {
      expect(parseMovePacked(bad)).toBeNull();
    }
  });
});

describe("part stat / send / recv / drop", () => {
  it("stat golden + strict parse", () => {
    expect(buildMovePartStatScript(MOVE_ID, 0, 7)).toBe(
      [
        "set -e",
        `D=${D0}`,
        'F="$D/p.00007"',
        '[ -f "$F" ] || { echo "part missing" >&2; exit 66; }',
        'S=$(stat -c %s "$F")',
        `H=$(awk '$2=="p.00007"{print $1}' "$D/sums")`,
        '[ -n "$H" ] || { echo "no checksum" >&2; exit 66; }',
        'echo "TUGRA_VX_PART $S $H"',
      ].join("\n"),
    );
    expect(parseMovePart(`TUGRA_VX_PART 1000 ${SHA}\n`)).toEqual({ size: 1000, sha256: SHA });
    for (const bad of ["", `TUGRA_VX_PART 0 ${SHA}`, "TUGRA_VX_PART 10 short", `TUGRA_VX_PART x ${SHA}`, `TUGRA_VX_PART 10 ${SHA} extra`, `TUGRA_VX_PART 10 ${SHA.toUpperCase()}`, `TUGRA_VX_PART 10 ${SHA}\nTUGRA_VX_PART 10 ${SHA}`]) {
      expect(parseMovePart(bad)).toBeNull();
    }
  });

  it("send golden: PUT of one part to the signed path under the agent's own origin, 14 min curl limit", () => {
    expect(buildMoveSendScript({ moveId: MOVE_ID, idx: 0, part: 7, path: RELAY })).toBe(
      [
        "set -e",
        'O="$TUGRA_HUB_ORIGIN"; [ -n "$O" ] || { echo "no hub origin" >&2; exit 64; }',
        `F=${D0}/p.00007; [ -f "$F" ]`,
        `curl -fsS --max-time 840 -X PUT -H 'Expect:' -H 'Content-Type: application/octet-stream' -T "$F" "$O"'${RELAY}' >/dev/null`,
        "echo TUGRA_VX_SEND_OK",
      ].join("\n"),
    );
  });

  it("recv golden: verified length + sha256 before the part is moved into place", () => {
    expect(buildMoveRecvScript({ moveId: MOVE_ID, idx: 0, part: 7, path: RELAY, size: 1000, sha256: SHA })).toBe(
      [
        "set -e",
        "set -o pipefail",
        'O="$TUGRA_HUB_ORIGIN"; [ -n "$O" ] || { echo "no hub origin" >&2; exit 64; }',
        `D=${D0}; umask 077; mkdir -p "$D"; F="$D/p.00007"; rm -f "$F.tmp"`,
        `trap 'rm -f "$F.tmp"' EXIT`,
        `curl -fsS --no-buffer --max-time 840 "$O"'${RELAY}' -o "$F.tmp"`,
        '[ "$(stat -c %s "$F.tmp")" = "1000" ] || { echo "size mismatch" >&2; exit 65; }',
        `[ "$(sha256sum "$F.tmp" | cut -d' ' -f1)" = "${SHA}" ] || { echo "sha mismatch" >&2; exit 66; }`,
        'mv "$F.tmp" "$F"; echo TUGRA_VX_RECV_OK',
      ].join("\n"),
    );
  });

  it("the relay path appears ONLY in send/recv scripts", () => {
    const others = [
      buildMovePrepareScript(MOVE_ID, [{ dockerName: "v" }]),
      buildMovePackScript({ moveId: MOVE_ID, idx: 0, dockerVolume: "v", partBytes: 4096 }),
      buildMovePartStatScript(MOVE_ID, 0, 0),
      buildMoveSourcePartDropScript(MOVE_ID, 0, 0),
      buildMoveApplyScript({ moveId: MOVE_ID, idx: 0, dockerVolume: "v", restoreId: "r", expectedEntries: 1 }),
      buildMoveCleanupScript(MOVE_ID, { removeVolumes: ["v"] }),
      buildMoveArchivePurgeScript(["v"]),
    ];
    for (const s of others) expect(s).not.toMatch(/agent-vx|TUGRA_HUB_ORIGIN|curl/);
    expect(buildMoveProbeScript({ dockerVolumes: ["v"] })).not.toMatch(/agent-vx|TUGRA_HUB_ORIGIN/); // it only checks that curl EXISTS
    expect(buildMoveSendScript({ moveId: MOVE_ID, idx: 0, part: 0, path: RELAY })).toContain("agent-vx");
    expect(buildMoveRecvScript({ moveId: MOVE_ID, idx: 0, part: 0, path: RELAY, size: 1, sha256: SHA })).toContain("agent-vx");
  });

  it("send/recv only accept the exact relay path shape (no host, no traversal, no extra query, no shell metacharacters)", () => {
    for (const bad of [
      "", "https://evil.example/api/v1/agent-vx/t/AAAAAAAAAAAAAAAAAAAAAAAA?exp=1&sig=BBBBBBBBBBBBBBBBBBBBBBBB",
      "/api/v1/agent-fs/t/AAAAAAAAAAAAAAAAAAAAAAAA?exp=1&sig=BBBBBBBBBBBBBBBBBBBBBBBB",
      "/api/v1/agent-vx/t/../x?exp=1&sig=BBBBBBBBBBBBBBBBBBBBBBBB",
      "/api/v1/agent-vx/t/AAAAAAAAAAAAAAAAAAAAAAAA?exp=1&sig=BBBBBBBBBBBBBBBBBBBBBBBB&x=1",
      "/api/v1/agent-vx/t/AAAAAAAAAAAAAAAAAAAAAAAA?exp=1&sig=BBBBBBBBBBBBBBBBBBBBBBBB;id",
      "/api/v1/agent-vx/t/AAAAAAAAAAAAAAAAAAAAAAAA?exp=1&sig=BBBBBBBBBBBBBBBBBBBBBBBB\n",
      "/api/v1/agent-vx/t/short?exp=1&sig=BBBBBBBBBBBBBBBBBBBBBBBB",
    ]) {
      expect(() => buildMoveSendScript({ moveId: MOVE_ID, idx: 0, part: 0, path: bad })).toThrow(/invalid relay path/);
      expect(() => buildMoveRecvScript({ moveId: MOVE_ID, idx: 0, part: 0, path: bad, size: 1, sha256: SHA })).toThrow(/invalid relay path/);
    }
  });

  it("recv validates size and sha256; curl time limits are bounded", () => {
    for (const size of [-1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 2]) expect(() => buildMoveRecvScript({ moveId: MOVE_ID, idx: 0, part: 0, path: RELAY, size, sha256: SHA })).toThrow();
    for (const sha256 of ["", "xyz", SHA.slice(1), SHA + "0", `${SHA.slice(0, 63)}"`]) expect(() => buildMoveRecvScript({ moveId: MOVE_ID, idx: 0, part: 0, path: RELAY, size: 1, sha256 })).toThrow(/invalid sha256/);
    expect(() => buildMoveSendScript({ moveId: MOVE_ID, idx: 0, part: 0, path: RELAY, maxTimeSec: 5 })).toThrow();
    expect(buildMoveSendScript({ moveId: MOVE_ID, idx: 0, part: 0, path: RELAY, maxTimeSec: 120 })).toContain("--max-time 120");
  });

  it("source part drop is a single rm of that part", () => {
    expect(buildMoveSourcePartDropScript(MOVE_ID, 0, 7)).toBe(`rm -f ${D0}/p.00007`);
    expect(() => buildMoveSourcePartDropScript(MOVE_ID, 0, 100_000)).toThrow();
  });
});

describe("buildMoveApplyScript", () => {
  const script = buildMoveApplyScript({ moveId: MOVE_ID, idx: 0, dockerVolume: "tugra_appv_capp_data", restoreId: `${MOVE_ID}_0`, expectedEntries: 12 });

  it("streams the gunzipped parts (no decoded tar on disk), twice: validate then extract, ownership preserved", () => {
    expect(script).toContain(`vx_stream() { cat ${D0}/p.* | gunzip; }`);
    expect(script).toContain(`vx_stream | docker run --rm -i ${IMG} tar -tf - > "$TMP.list"`);
    expect(script).toContain(`if vx_stream | docker run --rm -i -v 'tugra_appv_capp_data':/data ${IMG} sh -c 'cd /data && find . -mindepth 1 -delete; tar -xf -'; then`);
    expect(script).not.toContain("--no-same-owner"); // a trusted tugra->tugra transfer keeps numeric uid/gid
    expect(script).not.toContain('> "$TMP"'); // the decoded archive is never staged
    expect(script).not.toContain('< "$TMP"');
  });

  it("keeps the restore contract (72 before the wipe, 71 rolled back, 70 recovery) and verifies the entry count (68)", () => {
    for (const c of ["exit 72", "exit 71", "exit 70", "TUGRA_RESTORE_OK", `tugra_restore_rb_${MOVE_ID}_0`]) expect(script).toContain(c);
    expect(script).toContain('[ "$E" = "12" ] || { echo "entry count mismatch" >&2; exit 68; }');
    expect(script).toContain('echo "TUGRA_VX_APPLY_OK entries=$E"');
    expect(script.trimEnd().endsWith(`rm -rf ${D0}`)).toBe(true); // staging removed only after success
    expect(script.indexOf("TUGRA_VX_APPLY_OK")).toBeGreaterThan(script.indexOf("fi\n"));
    expect(script.split("\n").slice(0, 4)).toEqual(["set -e", "set -o pipefail", "TMP=$(mktemp)", `trap 'rm -f "$TMP" "$TMP.list"' EXIT`]);
  });

  it("rejects hostile volume names / restore ids / counts; parseMoveApplyOk is strict", () => {
    expect(() => buildMoveApplyScript({ moveId: MOVE_ID, idx: 0, dockerVolume: "a;b", restoreId: "r", expectedEntries: 1 })).toThrow();
    expect(() => buildMoveApplyScript({ moveId: MOVE_ID, idx: 0, dockerVolume: "v", restoreId: "r;x", expectedEntries: 1 })).toThrow(/invalid restore id/);
    expect(() => buildMoveApplyScript({ moveId: MOVE_ID, idx: 0, dockerVolume: "v", restoreId: "r", expectedEntries: -1 })).toThrow();
    expect(parseMoveApplyOk("TUGRA_VX_APPLY_OK entries=12\n")).toBe(12);
    for (const bad of ["", "TUGRA_VX_APPLY_OK entries=", "TUGRA_VX_APPLY_OK entries=1 x", "TUGRA_VX_APPLY_OK entries=1\nTUGRA_VX_APPLY_OK entries=1"]) expect(parseMoveApplyOk(bad)).toBeNull();
  });
});

describe("cleanup + archive purge builders", () => {
  it("cleanup golden: staging rm, label re-check before every volume rm, rollback snapshots by their own label", () => {
    expect(buildMoveCleanupScript(MOVE_ID, { removeVolumes: ["tugra_appv_capp_data"], removeRollbackFor: [`${MOVE_ID}_0`] })).toBe(
      [
        "set +e",
        `rm -rf ${MOVE_STAGING_ROOT}/${MOVE_ID}`,
        `if docker volume inspect 'tugra_appv_capp_data' >/dev/null 2>&1; then`,
        `  lb=$(docker volume inspect -f '{{index .Labels "tugra.move"}}' 'tugra_appv_capp_data' 2>/dev/null)`,
        `  if [ "$lb" = '${MOVE_ID}' ]; then if docker volume rm 'tugra_appv_capp_data' >/dev/null 2>&1; then echo "TUGRA_VX_VOL tugra_appv_capp_data removed"; else echo "TUGRA_VX_VOL tugra_appv_capp_data kept"; fi; else echo "TUGRA_VX_VOL tugra_appv_capp_data skipped"; fi`,
        `else echo "TUGRA_VX_VOL tugra_appv_capp_data absent"; fi`,
        `if docker volume inspect 'tugra_restore_rb_${MOVE_ID}_0' >/dev/null 2>&1; then`,
        `  lb=$(docker volume inspect -f '{{index .Labels "tugra.restore-rb"}}' 'tugra_restore_rb_${MOVE_ID}_0' 2>/dev/null)`,
        `  if [ "$lb" = '${MOVE_ID}_0' ]; then if docker volume rm 'tugra_restore_rb_${MOVE_ID}_0' >/dev/null 2>&1; then echo "TUGRA_VX_VOL tugra_restore_rb_${MOVE_ID}_0 removed"; else echo "TUGRA_VX_VOL tugra_restore_rb_${MOVE_ID}_0 kept"; fi; else echo "TUGRA_VX_VOL tugra_restore_rb_${MOVE_ID}_0 skipped"; fi`,
        `else echo "TUGRA_VX_VOL tugra_restore_rb_${MOVE_ID}_0 absent"; fi`,
        "echo TUGRA_VX_CLEANUP_DONE",
      ].join("\n"),
    );
  });

  it("cleanup with nothing listed only removes the staging dir; hostile names throw", () => {
    expect(buildMoveCleanupScript(MOVE_ID)).toBe(["set +e", `rm -rf ${MOVE_STAGING_ROOT}/${MOVE_ID}`, "echo TUGRA_VX_CLEANUP_DONE"].join("\n"));
    expect(() => buildMoveCleanupScript(MOVE_ID, { removeVolumes: ["a;b"] })).toThrow();
    expect(() => buildMoveCleanupScript(MOVE_ID, { removeRollbackFor: ["a b"] })).toThrow();
    expect(() => buildMoveCleanupScript("../x", {})).toThrow();
  });

  it("archive purge golden + hostile names", () => {
    expect(buildMoveArchivePurgeScript(["tugra_appv_capp_data"])).toBe(
      [
        "set +e",
        `if docker volume inspect 'tugra_appv_capp_data' >/dev/null 2>&1; then if docker volume rm 'tugra_appv_capp_data' >/dev/null 2>&1; then echo "TUGRA_VX_VOL tugra_appv_capp_data removed"; else echo "TUGRA_VX_VOL tugra_appv_capp_data kept"; fi; else echo "TUGRA_VX_VOL tugra_appv_capp_data absent"; fi`,
        "echo TUGRA_VX_CLEANUP_DONE",
      ].join("\n"),
    );
    expect(() => buildMoveArchivePurgeScript(["a;b"])).toThrow();
  });
});

describe("timeouts + scrubbing", () => {
  const GiB = 1024 ** 3;
  it("pack = 10 min + 150 s/GiB, apply = 10 min + 240 s/GiB, clamped to 24 h", () => {
    expect(MOVE_TIMEOUTS.pack(0)).toBe(600_000);
    expect(MOVE_TIMEOUTS.pack(GiB)).toBe(750_000);
    expect(MOVE_TIMEOUTS.pack(10 * GiB + 1)).toBe(600_000 + 11 * 150_000);
    expect(MOVE_TIMEOUTS.apply(0)).toBe(600_000);
    expect(MOVE_TIMEOUTS.apply(GiB)).toBe(840_000);
    expect(MOVE_TIMEOUTS.apply(10_000 * GiB)).toBe(24 * 3600_000);
    expect(MOVE_TIMEOUTS.pack(10_000 * GiB)).toBe(24 * 3600_000);
    expect([MOVE_TIMEOUTS.probe, MOVE_TIMEOUTS.prepare, MOVE_TIMEOUTS.stat, MOVE_TIMEOUTS.drop, MOVE_TIMEOUTS.transfer]).toEqual([600_000, 120_000, 120_000, 120_000, 900_000]);
    expect(MOVE_TIMEOUTS.pack(-5)).toBe(600_000);
  });

  it("scrubMoveOutput removes signed relay paths (with or without an origin) and a literal origin env, plus the shared secrets scrub", () => {
    const out = scrubMoveOutput(`curl: (22) The requested URL returned error: 404 for https://hub.example.com${RELAY}\nretry ${RELAY} now\nTUGRA_HUB_ORIGIN=https://hub.example.com\nPASSWORD=hunter2\nok`);
    expect(out).not.toContain("agent-vx/t/AAAA");
    expect(out).not.toContain("sig=");
    expect(out).not.toContain("hub.example.com");
    expect(out).not.toContain("hunter2");
    expect(out).toContain("<relay-path-redacted>");
    expect(out).toContain("ok");
    expect(scrubMoveOutput("")).toBe("");
  });
});
