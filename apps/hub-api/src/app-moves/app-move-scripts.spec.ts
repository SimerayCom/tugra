import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DOCKER_NAME_RE,
  MOVE_STAGING_ROOT,
  assertDockerName,
  assertIdx,
  assertMoveId,
  assertPart,
  buildMoveProbeScript,
  isValidDockerName,
  moveDir,
  parseMoveProbe,
  partName,
  probeHostPathKey,
  shq,
  volDir,
} from "./app-move-scripts";

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
