import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MOVE_STAGING_ROOT,
  buildMoveApplyScript,
  buildMoveArchivePurgeScript,
  buildMoveCleanupScript,
  buildMovePackScript,
  buildMovePartStatScript,
  buildMovePrepareScript,
  buildMoveRecvScript,
  buildMoveSendScript,
  buildMoveSourcePartDropScript,
  hasMarker,
  parseMoveApplyOk,
  parseMovePacked,
  parseMovePart,
  parseMovePrepare,
  parseMoveVolResults,
} from "./app-move-scripts";
import { mintRelayPath, newRelayId } from "./volume-relay-sig";

/**
 * "Shell lab": the REAL hub-built scripts executed by bash against stubbed docker/curl/stat/sha256sum, one directory
 * tree per simulated host. There is no docker in CI, so this is what proves the glue: part splitting, the pack ->
 * stat -> send/recv -> apply chain, the size/sha/entry checks, the restore exit-code contract (72/71/70/68) and the
 * label-guarded cleanup. The staging root is the only thing rewritten (to a temp dir per host).
 */
const MOVE_ID = "ckmoveabcdefghijklmnopqrs";
const VOL = "tugra_appv_capp_data";

const DOCKER = `#!/bin/bash
V="$VOLROOT"; mkdir -p "$V"
cmd="$1"; shift
case "$cmd" in
  image|pull) exit 0 ;;
  volume)
    sub="$1"; shift
    case "$sub" in
      inspect)
        fmt=""; if [ "$1" = "-f" ]; then fmt="$2"; shift 2; fi
        name="$1"; [ -d "$V/$name" ] || exit 1
        case "$fmt" in
          *Labels*) key=$(echo "$fmt" | sed -n 's/.*Labels "\\([^"]*\\)".*/\\1/p'); [ -f "$V/$name.labels/$key" ] && cat "$V/$name.labels/$key"; echo; exit 0 ;;
          *Mountpoint*) echo "$V/$name"; exit 0 ;;
        esac
        exit 0 ;;
      create)
        labels=(); while [ "$1" = "--label" ]; do labels+=("$2"); shift 2; done
        name="$1"; mkdir -p "$V/$name" "$V/$name.labels"
        for l in "\${labels[@]}"; do printf '%s' "\${l#*=}" > "$V/$name.labels/\${l%%=*}"; done
        echo "$name"; exit 0 ;;
      rm) name="$1"; [ -d "$V/$name" ] || exit 1; [ -f "$V/$name.inuse" ] && exit 1; rm -rf "$V/$name" "$V/$name.labels"; exit 0 ;;
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
const CURL = `#!/bin/bash
file=""; out=""; url=""
while [ $# -gt 0 ]; do case "$1" in -T) file="$2"; shift 2 ;; -o) out="$2"; shift 2 ;; --max-time|-X|-H) shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac; done
id=$(echo "$url" | sed -n 's#.*/agent-vx/t/\\([A-Za-z0-9_-]*\\)?.*#\\1#p')
[ -n "$id" ] || { echo "curl: (3) URL rejected" >&2; exit 3; }
[ -n "$RELAY_DOWN" ] && { echo "curl: (7) Failed to connect" >&2; exit 7; }
case "$url" in "$TUGRA_HUB_ORIGIN"/*) ;; *) echo "curl: wrong origin" >&2; exit 6 ;; esac
if [ -n "$file" ]; then cp "$file" "$RELAY/$id"; exit 0; fi
[ -f "$RELAY/$id" ] || exit 22
cp "$RELAY/$id" "$out"
[ -n "$RELAY_TAMPER" ] && printf 'X' | dd of="$out" bs=1 seek=3 conv=notrunc 2>/dev/null
if [ -n "$RELAY_TRUNC" ]; then n=$(wc -c < "$out"); head -c $((n-1)) "$out" > "$out.t" && mv "$out.t" "$out"; fi
exit 0
`;
const STAT = `#!/bin/bash
# only the GNU forms the scripts use
case "$2" in %s) wc -c < "$3" | tr -d ' ' ;; %d) echo 7 ;; *) exit 1 ;; esac
`;
// GNU sha256sum where it exists (Linux CI), else the macOS shasum with the same output format
const SHA = `#!/bin/bash
for c in /usr/bin/sha256sum /usr/local/bin/sha256sum /opt/homebrew/bin/sha256sum; do [ -x "$c" ] && exec "$c" "$@"; done
exec shasum -a 256 "$@"
`;

describe("move scripts executed in a simulated two-host lab", () => {
  let root: string;
  let bin: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "tugra-lab-"));
    bin = join(root, "bin");
    mkdirSync(bin);
    for (const [n, body] of [["docker", DOCKER], ["curl", CURL], ["stat", STAT], ["sha256sum", SHA]] as const) {
      writeFileSync(join(bin, n), body);
      chmodSync(join(bin, n), 0o755);
    }
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  let side = 0;
  /** A fresh pair of hosts + a shared relay dir. */
  function lab() {
    const dir = join(root, `lab${side++}`);
    const relay = join(dir, "relay");
    mkdirSync(relay, { recursive: true });
    const host = (name: string) => {
      const base = join(dir, name);
      mkdirSync(join(base, "vols"), { recursive: true });
      mkdirSync(join(base, "app-moves"), { recursive: true });
      return {
        base,
        vols: join(base, "vols"),
        staging: join(base, "app-moves"),
        run(script: string, env: Record<string, string> = {}): { code: number; out: string } {
          const text = script.replaceAll(MOVE_STAGING_ROOT, join(base, "app-moves"));
          const r = spawnSync("bash", ["-c", text], {
            encoding: "utf8",
            env: { PATH: `${bin}:${process.env.PATH}`, VOLROOT: join(base, "vols"), RELAY: relay, TUGRA_HUB_ORIGIN: "http://hub.test", ...env },
          });
          return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
        },
      };
    };
    // host dir names must not contain the container mount points (/src /dst /data) the docker stub rewrites
    return { src: host("hostA"), dst: host("hostB"), relay };
  }

  const relayPath = () => mintRelayPath("lab-secret-0123456789", { id: newRelayId(), role: "src", serverId: "s1", moveId: MOVE_ID, volIdx: 0, part: 0, size: 1, sha256: "a".repeat(64) }, Math.floor(Date.now() / 1000) + 300);
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

  function seedSource(h: { vols: string }, name = VOL) {
    const d = join(h.vols, name);
    mkdirSync(join(d, "sub", "deep"), { recursive: true });
    writeFileSync(join(d, "random.bin"), randomBytes(6000)); // incompressible: forces several 1 KiB parts
    writeFileSync(join(d, ".hidden"), "dotfile\n");
    writeFileSync(join(d, "sub", "deep", "note.txt"), "hello\n");
    symlinkSync("random.bin", join(d, "link"));
    return d;
  }
  const tree = (d: string): string[] => {
    const out: string[] = [];
    const walk = (p: string, rel: string) => {
      for (const e of readdirSync(p, { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        out.push(e.isDirectory() ? `${r}/` : e.isSymbolicLink() ? `${r}@` : `${r}:${sha(readFileSync(join(p, e.name)))}`);
        if (e.isDirectory()) walk(join(p, e.name), r);
      }
    };
    walk(d, "");
    return out.sort();
  };

  /** pack on src, then per part: stat -> send -> recv -> drop; returns what the hub would record. */
  function transfer(l: ReturnType<typeof lab>, opts: { recvEnv?: Record<string, string>; sendEnv?: Record<string, string>; partBytes?: number } = {}) {
    const pack = l.src.run(buildMovePackScript({ moveId: MOVE_ID, idx: 0, dockerVolume: VOL, partBytes: opts.partBytes ?? 1024 }));
    expect(pack.code).toBe(0);
    const packed = parseMovePacked(pack.out)!;
    expect(packed).not.toBeNull();
    const results: { part: number; send: number; recv: number }[] = [];
    for (let p = 0; p < packed.parts; p++) {
      const stat = l.src.run(buildMovePartStatScript(MOVE_ID, 0, p));
      expect(stat.code).toBe(0);
      const info = parseMovePart(stat.out)!;
      const path = relayPath();
      const send = l.src.run(buildMoveSendScript({ moveId: MOVE_ID, idx: 0, part: p, path }), opts.sendEnv);
      const recv = l.dst.run(buildMoveRecvScript({ moveId: MOVE_ID, idx: 0, part: p, path, size: info.size, sha256: info.sha256 }), opts.recvEnv);
      results.push({ part: p, send: send.code, recv: recv.code });
      if (send.code === 0 && recv.code === 0) expect(l.src.run(buildMoveSourcePartDropScript(MOVE_ID, 0, p)).code).toBe(0);
    }
    return { packed, results };
  }

  it("prepare creates the staging dir and labelled volumes, reports 1/0 per volume, and never recreates an existing one", () => {
    const l = lab();
    const script = buildMovePrepareScript(MOVE_ID, [{ dockerName: VOL }, { dockerName: "tugra_capp_dbdata", compose: { project: "tugra_capp", key: "dbdata" } }]);
    const r = l.dst.run(script);
    expect(r.code).toBe(0);
    expect(parseMovePrepare(r.out, [VOL, "tugra_capp_dbdata"])).toEqual({ [VOL]: true, tugra_capp_dbdata: true });
    expect(existsSync(join(l.dst.staging, MOVE_ID))).toBe(true);
    expect(readFileSync(join(l.dst.vols, `${VOL}.labels`, "tugra.move"), "utf8")).toBe(MOVE_ID);
    expect(readFileSync(join(l.dst.vols, "tugra_capp_dbdata.labels", "com.docker.compose.project"), "utf8")).toBe("tugra_capp");
    expect(readFileSync(join(l.dst.vols, "tugra_capp_dbdata.labels", "com.docker.compose.volume"), "utf8")).toBe("dbdata");
    expect(existsSync(join(l.dst.vols, `${VOL}.labels`, "com.docker.compose.project"))).toBe(false); // plain app volume: only our label
    const again = l.dst.run(script);
    expect(parseMovePrepare(again.out, [VOL, "tugra_capp_dbdata"])).toEqual({ [VOL]: false, tugra_capp_dbdata: false });
  });

  it("happy path: pack -> per-part stat/send/recv/drop -> apply reproduces the volume byte for byte (several parts, dotfiles, symlinks)", () => {
    const l = lab();
    const srcVol = seedSource(l.src);
    expect(l.dst.run(buildMovePrepareScript(MOVE_ID, [{ dockerName: VOL }])).code).toBe(0);
    const { packed, results } = transfer(l);
    expect(packed.parts).toBeGreaterThan(3);
    expect(results.every((r) => r.send === 0 && r.recv === 0)).toBe(true);
    // the source parts were dropped progressively; only the checksum file is left
    expect(readdirSync(join(l.src.staging, MOVE_ID, "0")).filter((f) => f.startsWith("p."))).toEqual([]);
    const apply = l.dst.run(buildMoveApplyScript({ moveId: MOVE_ID, idx: 0, dockerVolume: VOL, restoreId: `${MOVE_ID}_0`, expectedEntries: packed.entries }));
    expect(apply.code).toBe(0);
    expect(parseMoveApplyOk(apply.out)).toBe(packed.entries);
    expect(hasMarker(apply.out, "TUGRA_RESTORE_OK")).toBe(true);
    expect(tree(join(l.dst.vols, VOL))).toEqual(tree(srcVol));
    expect(existsSync(join(l.dst.staging, MOVE_ID, "0"))).toBe(false); // staging removed after a successful apply
    expect(existsSync(join(l.dst.vols, `tugra_restore_rb_${MOVE_ID}_0`))).toBe(false); // snapshot volume removed on success
    expect(packed.entries).toBe(6); // random.bin .hidden link sub sub/deep sub/deep/note.txt
  });

  it("an empty volume packs to a valid single part and applies cleanly", () => {
    const l = lab();
    mkdirSync(join(l.src.vols, VOL), { recursive: true });
    l.dst.run(buildMovePrepareScript(MOVE_ID, [{ dockerName: VOL }]));
    const { packed } = transfer(l, { partBytes: 1_000_000 });
    expect(packed).toEqual({ parts: 1, entries: 0 });
    expect(l.dst.run(buildMoveApplyScript({ moveId: MOVE_ID, idx: 0, dockerVolume: VOL, restoreId: "r", expectedEntries: 0 })).code).toBe(0);
  });

  it("receive verifies exact length (65) and sha256 (66); a flipped byte or a short part never lands in place", () => {
    for (const [env, code] of [[{ RELAY_TAMPER: "1" }, 66], [{ RELAY_TRUNC: "1" }, 65]] as const) {
      const l = lab();
      seedSource(l.src);
      const { results } = transfer(l, { recvEnv: env });
      expect(results[0].recv).toBe(code);
      expect(existsSync(join(l.dst.staging, MOVE_ID, "0", "p.00000"))).toBe(false); // not moved into place
      expect(existsSync(join(l.dst.staging, MOVE_ID, "0", "p.00000.tmp"))).toBe(false); // the temp copy is removed too
    }
  });

  it("send/recv fail with 64 when the agent did not export TUGRA_HUB_ORIGIN, and a relay outage is a plain failure", () => {
    const l = lab();
    seedSource(l.src);
    expect(l.src.run(buildMovePackScript({ moveId: MOVE_ID, idx: 0, dockerVolume: VOL, partBytes: 1024 })).code).toBe(0);
    const path = relayPath();
    const noOrigin = { TUGRA_HUB_ORIGIN: "" };
    expect(l.src.run(buildMoveSendScript({ moveId: MOVE_ID, idx: 0, part: 0, path }), noOrigin).code).toBe(64);
    expect(l.dst.run(buildMoveRecvScript({ moveId: MOVE_ID, idx: 0, part: 0, path, size: 1, sha256: "a".repeat(64) }), noOrigin).code).toBe(64);
    expect(l.src.run(buildMoveSendScript({ moveId: MOVE_ID, idx: 0, part: 0, path }), { RELAY_DOWN: "1" }).code).toBe(7);
    // sending a part that does not exist fails before curl
    expect(l.src.run(buildMoveSendScript({ moveId: MOVE_ID, idx: 0, part: 99, path })).code).not.toBe(0);
  });

  it("part stat fails (66) for a missing part", () => {
    const l = lab();
    seedSource(l.src);
    l.src.run(buildMovePackScript({ moveId: MOVE_ID, idx: 0, dockerVolume: VOL, partBytes: 1024 }));
    expect(l.src.run(buildMovePartStatScript(MOVE_ID, 0, 500)).code).toBe(66);
  });

  describe("apply failure contract", () => {
    function readyForApply() {
      const l = lab();
      seedSource(l.src);
      const dstVol = join(l.dst.vols, VOL);
      mkdirSync(dstVol, { recursive: true });
      writeFileSync(join(dstVol, "precious.txt"), "archive data that must survive a failed apply");
      const { packed } = transfer(l);
      const apply = (env: Record<string, string> = {}, entries = packed.entries) =>
        l.dst.run(buildMoveApplyScript({ moveId: MOVE_ID, idx: 0, dockerVolume: VOL, restoreId: `${MOVE_ID}_0`, expectedEntries: entries }), env);
      return { l, dstVol, packed, apply };
    }

    it("a corrupt/truncated part aborts BEFORE the wipe (72) and the live data is intact", () => {
      const { l, dstVol, apply } = readyForApply();
      const part = join(l.dst.staging, MOVE_ID, "0", "p.00001");
      writeFileSync(part, Buffer.from("this is not gzip data at all"));
      const r = apply();
      expect(r.code).toBe(72);
      expect(readFileSync(join(dstVol, "precious.txt"), "utf8")).toContain("must survive");
      expect(existsSync(join(l.dst.vols, `tugra_restore_rb_${MOVE_ID}_0`))).toBe(false); // nothing to clean: aborted before the snapshot
    });

    it("an extract failure rolls back from the snapshot (71) and the old data is restored", () => {
      const { dstVol, apply } = readyForApply();
      const r = apply({ FAIL_EXTRACT: "1" });
      expect(r.code).toBe(71);
      expect(r.out).toContain("TUGRA_RESTORE_FAILED_ROLLED_BACK");
      expect(readFileSync(join(dstVol, "precious.txt"), "utf8")).toContain("must survive");
    });

    it("extract AND rollback failing is 70: the snapshot volume is kept for manual recovery", () => {
      const { l, apply } = readyForApply();
      const r = apply({ FAIL_EXTRACT: "1", FAIL_RESTORE: "1" });
      expect(r.code).toBe(70);
      expect(r.out).toContain(`TUGRA_RESTORE_RECOVERY_REQUIRED rollback=tugra_restore_rb_${MOVE_ID}_0`);
      expect(existsSync(join(l.dst.vols, `tugra_restore_rb_${MOVE_ID}_0`))).toBe(true);
    });

    it("an entry count that differs from the packed one is 68", () => {
      const { apply, packed } = readyForApply();
      const r = apply({}, packed.entries + 1);
      expect(r.code).toBe(68);
      expect(r.out).toContain("entry count mismatch");
    });
  });

  describe("cleanup is label-guarded", () => {
    it("removes the staging dir and ONLY volumes labelled for this move; foreign/unlabelled ones are skipped, in-use ones kept, missing ones absent", () => {
      const l = lab();
      l.dst.run(buildMovePrepareScript(MOVE_ID, [{ dockerName: VOL }, { dockerName: "tugra_appv_capp_inuse" }]));
      writeFileSync(join(l.dst.vols, "tugra_appv_capp_inuse.inuse"), "");
      mkdirSync(join(l.dst.vols, "tugra_appv_capp_foreign", ), { recursive: true }); // no labels at all
      mkdirSync(join(l.dst.vols, "tugra_appv_capp_other.labels"), { recursive: true });
      mkdirSync(join(l.dst.vols, "tugra_appv_capp_other"), { recursive: true });
      writeFileSync(join(l.dst.vols, "tugra_appv_capp_other.labels", "tugra.move"), "ckanothermoveabcdefghijk");
      const rbName = `tugra_restore_rb_${MOVE_ID}_0`;
      mkdirSync(join(l.dst.vols, rbName), { recursive: true });
      mkdirSync(join(l.dst.vols, `${rbName}.labels`), { recursive: true });
      writeFileSync(join(l.dst.vols, `${rbName}.labels`, "tugra.restore-rb"), `${MOVE_ID}_0`);
      const names = [VOL, "tugra_appv_capp_inuse", "tugra_appv_capp_foreign", "tugra_appv_capp_other", "tugra_appv_capp_gone"];
      const r = l.dst.run(buildMoveCleanupScript(MOVE_ID, { removeVolumes: names, removeRollbackFor: [`${MOVE_ID}_0`] }));
      expect(r.code).toBe(0);
      expect(existsSync(join(l.dst.staging, MOVE_ID))).toBe(false);
      expect(existsSync(join(l.dst.vols, VOL))).toBe(false); // ours: removed
      expect(existsSync(join(l.dst.vols, "tugra_appv_capp_inuse"))).toBe(true); // docker refused: kept
      expect(existsSync(join(l.dst.vols, "tugra_appv_capp_foreign"))).toBe(true); // unlabelled: never touched
      expect(existsSync(join(l.dst.vols, "tugra_appv_capp_other"))).toBe(true); // another move's label: never touched
      expect(existsSync(join(l.dst.vols, rbName))).toBe(false); // the rollback snapshot of this apply: removed
      const parsed = parseMoveVolResults(r.out, [...names, rbName]);
      expect(parsed.complete).toBe(true);
      expect(parsed.leftover).toEqual(["tugra_appv_capp_inuse"]);
    });

    it("parseMoveVolResults: a missing end marker or a missing volume result is NOT complete/clean", () => {
      expect(parseMoveVolResults("TUGRA_VX_VOL a removed\n", ["a"])).toEqual({ complete: false, leftover: [] });
      expect(parseMoveVolResults("TUGRA_VX_VOL a removed\nTUGRA_VX_CLEANUP_DONE\n", ["a", "b"])).toEqual({ complete: true, leftover: ["b"] });
      expect(parseMoveVolResults("TUGRA_VX_VOL a kept\nTUGRA_VX_CLEANUP_DONE\n", ["a"]).leftover).toEqual(["a"]);
    });

    it("archive purge removes the listed volumes, keeps an in-use one, reports absent ones", () => {
      const l = lab();
      seedSource(l.src);
      mkdirSync(join(l.src.vols, "tugra_appv_capp_busy"), { recursive: true });
      writeFileSync(join(l.src.vols, "tugra_appv_capp_busy.inuse"), "");
      const r = l.src.run(buildMoveArchivePurgeScript([VOL, "tugra_appv_capp_busy", "tugra_appv_capp_none"]));
      expect(r.code).toBe(0);
      expect(existsSync(join(l.src.vols, VOL))).toBe(false);
      expect(existsSync(join(l.src.vols, "tugra_appv_capp_busy"))).toBe(true);
      expect(parseMoveVolResults(r.out, [VOL, "tugra_appv_capp_busy", "tugra_appv_capp_none"]).leftover).toEqual(["tugra_appv_capp_busy"]);
    });
  });

  it("source data is never modified by pack (the volume mounts read-only in the real command)", () => {
    const l = lab();
    const srcVol = seedSource(l.src);
    const before = tree(srcVol);
    l.src.run(buildMovePackScript({ moveId: MOVE_ID, idx: 0, dockerVolume: VOL, partBytes: 1024 }));
    expect(tree(srcVol)).toEqual(before);
    expect(buildMovePackScript({ moveId: MOVE_ID, idx: 0, dockerVolume: VOL, partBytes: 1024 })).toContain(`-v '${VOL}':/data:ro`);
  });
});
