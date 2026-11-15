import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MOVE_STAGING_ROOT } from "../../app-moves/app-move-scripts";
import {
  MIGRATION_EXIT,
  buildMigrationApplyScript,
  buildMigrationCleanupScript,
  buildMigrationPartStatScript,
  buildMigrationStateProbeScript,
  buildMigrationWipeDestScript,
  migrationRestoreId,
  parseMigrationApplyOk,
  parseMigrationStateProbe,
} from "./vx-scripts";
import { parseMovePart } from "../../app-moves/app-move-scripts";

/**
 * "Shell lab" for the migration apply: the REAL hub-built scripts executed by bash against a stubbed docker (one volume
 * directory tree per simulated host). There is no docker in CI, so this proves the glue: the double stream with
 * `drain`, the exit-code contract (0/72/71/70/67/68/69), the entry and PG_VERSION checks, the `applied` marker order,
 * the lock file lifecycle and the label-guarded cleanup. Only the staging root is rewritten (to a temp dir).
 */
const ID = "cktransferabcdefghijklmnopq";
const VOL = "tugra_appv_capp_data";

const DOCKER = `#!/bin/bash
V="$VOLROOT"; mkdir -p "$V"
cmd="$1"; shift
case "$cmd" in
  image|pull) exit 0 ;;
  volume)
    sub="$1"; shift
    case "$sub" in
      ls)
        # volume ls -q --filter name=<prefix>
        pfx=""; while [ $# -gt 0 ]; do case "$1" in --filter) pfx="\${2#name=}"; shift 2 ;; *) shift ;; esac; done
        for d in "$V"/*/; do n=$(basename "$d"); case "$n" in *.labels) continue ;; esac; case "$n" in $pfx*) echo "$n" ;; esac; done; exit 0 ;;
      inspect)
        fmt=""; if [ "$1" = "-f" ]; then fmt="$2"; shift 2; fi
        name="$1"; [ -d "$V/$name" ] || exit 1
        case "$fmt" in
          *Labels*) key=$(echo "$fmt" | sed -n 's/.*Labels "\\([^"]*\\)".*/\\1/p'); [ -f "$V/$name.labels/$key" ] && cat "$V/$name.labels/$key"; echo; exit 0 ;;
        esac
        exit 0 ;;
      create)
        labels=(); while [ "$1" = "--label" ]; do labels+=("$2"); shift 2; done
        name="$1"; mkdir -p "$V/$name" "$V/$name.labels"
        for l in "\${labels[@]}"; do printf '%s' "\${l#*=}" > "$V/$name.labels/\${l%%=*}"; done
        echo "$name"; exit 0 ;;
      rm) name="$1"; [ -d "$V/$name" ] || exit 1; rm -rf "$V/$name" "$V/$name.labels"; exit 0 ;;
    esac ;;
  run)
    mounts=()
    while [ $# -gt 0 ]; do case "$1" in --rm|-i|--pull=never) shift ;; -v) mounts+=("$2"); shift 2 ;; *) break ;; esac; done
    shift
    out=()
    for a in "$@"; do
      for m in "\${mounts[@]}"; do name="\${m%%:*}"; rest="\${m#*:}"; cpath="\${rest%%:*}"; a="\${a//$cpath/$V/$name}"; done
      out+=("$a")
    done
    flat="\${out[*]}"
    if [ -n "$FAIL_EXTRACT" ] && [[ "$flat" == *"tar -xf -"* ]]; then cat >/dev/null; exit 1; fi
    if [ -n "$FAIL_RESTORE" ] && [[ "$flat" == *"-delete; cp -a"* ]]; then exit 1; fi
    exec "\${out[@]}" ;;
esac
exit 1
`;
const STAT = `#!/bin/bash
case "$2" in %s) wc -c < "$3" | tr -d ' ' ;; *) exit 1 ;; esac
`;
const SHA = `#!/bin/bash
for c in /usr/bin/sha256sum /usr/local/bin/sha256sum /opt/homebrew/bin/sha256sum; do [ -x "$c" ] && exec "$c" "$@"; done
exec shasum -a 256 "$@"
`;

describe("migration apply scripts executed against a stubbed docker", () => {
  let root: string;
  let bin: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "tugra-vxlab-"));
    bin = join(root, "bin");
    mkdirSync(bin);
    for (const [n, body] of [["docker", DOCKER], ["stat", STAT], ["sha256sum", SHA]] as const) {
      writeFileSync(join(bin, n), body);
      chmodSync(join(bin, n), 0o755);
    }
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  let n = 0;
  function host() {
    const base = join(root, `h${n++}`);
    mkdirSync(join(base, "vols", VOL), { recursive: true });
    mkdirSync(join(base, "app-moves"), { recursive: true });
    const run = (script: string, env: Record<string, string> = {}): { code: number; out: string } => {
      const text = script.replaceAll(MOVE_STAGING_ROOT, join(base, "app-moves"));
      const r = spawnSync("bash", ["-c", text], { encoding: "utf8", env: { PATH: `${bin}:${process.env.PATH}`, VOLROOT: join(base, "vols"), ...env } });
      return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
    };
    const volDir = (name = VOL) => join(base, "vols", name);
    const stage = join(base, "app-moves", ID);
    return { base, run, volDir, stage };
  }

  /** Build a source tree, tar it, cut the tar into gzip members of `slice` raw bytes (what the migrator streams). */
  function makeParts(h: ReturnType<typeof host>, files: Record<string, string | Buffer>, slice = 4096): { rawBytes: number; entries: number } {
    const src = join(h.base, "src");
    rmSync(src, { recursive: true, force: true });
    mkdirSync(src, { recursive: true });
    for (const [p, c] of Object.entries(files)) {
      mkdirSync(join(src, p, ".."), { recursive: true });
      writeFileSync(join(src, p), c);
    }
    const tar = spawnSync("tar", ["-C", src, "-cf", "-", "."], { maxBuffer: 1 << 28 });
    if (tar.status !== 0) throw new Error("tar failed");
    const raw = tar.stdout as Buffer;
    mkdirSync(join(h.stage, "0"), { recursive: true });
    let i = 0;
    for (let off = 0; off < raw.length; off += slice, i++) {
      const gz = spawnSync("gzip", ["-1", "-n", "-c"], { input: raw.subarray(off, off + slice), maxBuffer: 1 << 28 }).stdout as Buffer;
      writeFileSync(join(h.stage, "0", `p.${String(i).padStart(5, "0")}`), gz);
    }
    const entries = Number(spawnSync("sh", ["-c", `find ${src} -mindepth 1 | wc -l`], { encoding: "utf8" }).stdout.trim());
    return { rawBytes: raw.length, entries };
  }

  const apply = (o: Partial<Parameters<typeof buildMigrationApplyScript>[0]> & { rawBytes: number; expectedEntries: number }) =>
    buildMigrationApplyScript({ transferId: ID, dockerVolume: VOL, restoreId: migrationRestoreId(ID, 1), excludes: [], ...o });
  const files = { "a.txt": "hello", "sub/b.bin": Buffer.alloc(9000, 7), "sub/deep/c.txt": "deep" };

  it("happy path: extracts, writes `applied` BEFORE removing the parts, removes the lock, prints the marker", () => {
    const h = host();
    const { rawBytes, entries } = makeParts(h, files);
    expect(readdirSync(join(h.stage, "0")).length).toBeGreaterThan(2);
    const r = h.run(apply({ rawBytes, expectedEntries: entries }));
    expect(r.code).toBe(0);
    expect(parseMigrationApplyOk(r.out)).toBe(entries);
    expect(readFileSync(join(h.volDir(), "a.txt"), "utf8")).toBe("hello");
    expect(readFileSync(join(h.volDir(), "sub/deep/c.txt"), "utf8")).toBe("deep");
    expect(existsSync(join(h.stage, "applied"))).toBe(true);
    expect(existsSync(join(h.stage, "0"))).toBe(false); // parts removed
    expect(existsSync(join(h.stage, "applying.lock"))).toBe(false); // lock removed on EXIT
    const script = apply({ rawBytes, expectedEntries: entries });
    expect(script.indexOf(': > "$ROOT/applied"')).toBeGreaterThan(0);
    expect(script.indexOf(': > "$ROOT/applied"')).toBeLessThan(script.indexOf('rm -rf "$DIR"'));
    expect(script.indexOf('echo "TUGRA_VX_APPLY_OK')).toBeLessThan(script.indexOf('rm -rf "$DIR"'));
  });

  it("no staged parts -> 67, nothing touched", () => {
    const h = host();
    writeFileSync(join(h.volDir(), "keep.txt"), "x");
    const r = h.run(apply({ rawBytes: 1024, expectedEntries: 1 }));
    expect(r.code).toBe(MIGRATION_EXIT.noParts);
    expect(existsSync(join(h.volDir(), "keep.txt"))).toBe(true);
  });

  it("a decoded stream longer than rawBytes is cut: the archive is invalid, the destination is intact", () => {
    const h = host();
    writeFileSync(join(h.volDir(), "live.txt"), "live data");
    const { rawBytes, entries } = makeParts(h, files);
    const r = h.run(apply({ rawBytes: Math.floor(rawBytes / 2), expectedEntries: entries })); // cut into the middle of a file
    expect([72, 71]).toContain(r.code); // fails closed (72 before the wipe, 71 if it got as far as the rollback)
    expect(readFileSync(join(h.volDir(), "live.txt"), "utf8")).toBe("live data");
    expect(existsSync(join(h.stage, "applied"))).toBe(false);
    expect(existsSync(join(h.stage, "0"))).toBe(true); // parts kept for a retry
  });

  it("extract failure -> 71 and the live data is rolled back from the snapshot", () => {
    const h = host();
    writeFileSync(join(h.volDir(), "live.txt"), "live data");
    const { rawBytes, entries } = makeParts(h, files);
    const r = h.run(apply({ rawBytes, expectedEntries: entries }), { FAIL_EXTRACT: "1" });
    expect(r.code).toBe(71);
    expect(readFileSync(join(h.volDir(), "live.txt"), "utf8")).toBe("live data");
    expect(existsSync(join(h.stage, "applied"))).toBe(false);
    expect(existsSync(join(h.stage, "applying.lock"))).toBe(false);
  });

  it("extract AND rollback failing -> 70 recovery required, the snapshot volume is kept", () => {
    const h = host();
    writeFileSync(join(h.volDir(), "live.txt"), "live data");
    const { rawBytes, entries } = makeParts(h, files);
    const r = h.run(apply({ rawBytes, expectedEntries: entries }), { FAIL_EXTRACT: "1", FAIL_RESTORE: "1" });
    expect(r.code).toBe(70);
    expect(r.out).toContain("TUGRA_RESTORE_RECOVERY_REQUIRED");
    expect(existsSync(h.volDir(`tugra_restore_rb_${migrationRestoreId(ID, 1)}`))).toBe(true);
  });

  it("entry count mismatch -> 68 and no `applied` marker", () => {
    const h = host();
    const { rawBytes, entries } = makeParts(h, files);
    const r = h.run(apply({ rawBytes, expectedEntries: entries + 5 }));
    expect(r.code).toBe(MIGRATION_EXIT.entryMismatch);
    expect(existsSync(join(h.stage, "applied"))).toBe(false);
    expect(existsSync(join(h.stage, "0"))).toBe(true);
  });

  it("db-data: PG_VERSION must match the expected major (69), and a postmaster.pid exclude is applied to the count", () => {
    const h = host();
    const { rawBytes, entries } = makeParts(h, { "PG_VERSION": "16\n", "base/1/x": "d" });
    const bad = h.run(apply({ rawBytes, expectedEntries: entries, expectPgMajor: "17" }));
    expect(bad.code).toBe(MIGRATION_EXIT.pgVersion);
    expect(existsSync(join(h.stage, "applied"))).toBe(false);
    const h2 = host();
    const m2 = makeParts(h2, { "PG_VERSION": "16\n", "base/1/x": "d" });
    const ok = h2.run(apply({ rawBytes: m2.rawBytes, expectedEntries: m2.entries, expectPgMajor: "16", excludes: ["postmaster.pid"] }));
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/TUGRA_VX_APPLY_OK entries=\d+/);
  });

  it("the end-of-archive marker may straddle any gunzip chunk: 200 archive sizes all apply with `drain`", () => {
    for (let k = 0; k < 200; k++) {
      const h = host();
      const size = 31_000 + k * 17; // sweeps the padded end marker across the 32 KiB read boundary
      const { rawBytes, entries } = makeParts(h, { "f.bin": Buffer.alloc(size, k % 251) }, 6000 + (k % 7) * 1000);
      const r = h.run(apply({ rawBytes, expectedEntries: entries }));
      if (r.code !== 0) throw new Error(`iteration ${k} (size ${size}): exit ${r.code}\n${r.out}`);
    }
  }, 120_000);

  it("state probe: running / applied / parts / rollback volume are reported exactly once", async () => {
    const h = host();
    mkdirSync(join(h.stage, "0"), { recursive: true });
    for (const p of ["p.00000", "p.00001", "p.00002.tmp", "junk"]) writeFileSync(join(h.stage, "0", p), "x");
    let r = h.run(buildMigrationStateProbeScript(ID));
    expect(parseMigrationStateProbe(r.out)).toEqual({ running: false, applied: false, parts: 2, rollbackVolume: false });
    writeFileSync(join(h.stage, "applied"), "");
    mkdirSync(h.volDir(`tugra_restore_rb_vx${ID}1`));
    r = h.run(buildMigrationStateProbeScript(ID));
    expect(parseMigrationStateProbe(r.out)).toEqual({ running: false, applied: true, parts: 2, rollbackVolume: true });
    // a live pid in the lock file = running; a dead one = not running
    const sleeper = spawn("sleep", ["30"]);
    try {
      writeFileSync(join(h.stage, "applying.lock"), String(sleeper.pid));
      expect(parseMigrationStateProbe(h.run(buildMigrationStateProbeScript(ID)).out)?.running).toBe(true);
    } finally {
      sleeper.kill();
    }
    writeFileSync(join(h.stage, "applying.lock"), "999999");
    expect(parseMigrationStateProbe(h.run(buildMigrationStateProbeScript(ID)).out)?.running).toBe(false);
  });

  it("wipe-dest empties the volume; with the transfer id it also removes ONLY label-proven rollback snapshots of that transfer", () => {
    const h = host();
    writeFileSync(join(h.volDir(), "partial.bin"), "half");
    mkdirSync(join(h.volDir(), "d"));
    const mine = `tugra_restore_rb_vx${ID}1`;
    const foreign = `tugra_restore_rb_vx${ID}2`; // same prefix but its label says it is not ours
    for (const [v, label] of [[mine, `vx${ID}1`], [foreign, "someoneelse"]] as const) {
      mkdirSync(h.volDir(v), { recursive: true });
      mkdirSync(h.volDir(`${v}.labels`), { recursive: true });
      writeFileSync(join(h.volDir(`${v}.labels`), "tugra.restore-rb"), label);
    }
    expect(h.run(buildMigrationWipeDestScript(VOL, ID)).code).toBe(0);
    expect(readdirSync(h.volDir())).toEqual([]);
    expect(existsSync(h.volDir(mine))).toBe(false);
    expect(existsSync(h.volDir(foreign))).toBe(true);
  });

  it("cleanup removes the staging dir and this transfer's snapshots, always printing the end marker", () => {
    const h = host();
    mkdirSync(join(h.stage, "0"), { recursive: true });
    writeFileSync(join(h.stage, "0", "p.00000"), "x");
    const r = h.run(buildMigrationCleanupScript(ID));
    expect(r.code).toBe(0);
    expect(r.out).toContain("TUGRA_VX_CLEANUP_DONE");
    expect(existsSync(h.stage)).toBe(false);
  });

  it("part stat prints size + sha256 of the staged part (parsed by the move parser), and fails when it is missing", () => {
    const h = host();
    mkdirSync(join(h.stage, "0"), { recursive: true });
    const body = Buffer.from("part-bytes");
    writeFileSync(join(h.stage, "0", "p.00003"), body);
    const r = h.run(buildMigrationPartStatScript(ID, 3));
    expect(parseMovePart(r.out)).toEqual({ size: body.length, sha256: createHash("sha256").update(body).digest("hex") });
    expect(h.run(buildMigrationPartStatScript(ID, 4)).code).toBe(66);
  });
});
