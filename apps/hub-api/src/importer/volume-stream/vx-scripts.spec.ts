import { BACKUP_HELPER_IMAGE } from "../../volume-backups/volume-backup-script";
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

const IMG = BACKUP_HELPER_IMAGE;
const ID = "cktransferabcdefghijklmnopq";
const VOL = "tugra_appv_capp_data";
const base = { transferId: ID, dockerVolume: VOL, restoreId: `vx${ID}1`, expectedEntries: 42, rawBytes: 1234567, excludes: [] as string[] };

describe("buildMigrationApplyScript (golden)", () => {
  it("app volume: stream apply with drain, ownership preserved, applied marker before the parts are removed", () => {
    const s = buildMigrationApplyScript(base);
    const R = `/etc/tugra/app-moves/${ID}`;
    expect(s.split("\n").slice(0, 10)).toEqual([
      "set -e",
      "set -o pipefail",
      `ROOT=${R}`,
      'DIR="$ROOT/0"',
      '[ -d "$DIR" ] || { echo "no staged parts" >&2; exit 67; }',
      'echo $$ > "$ROOT/applying.lock"',
      "TMP=$(mktemp)",
      `trap 'rm -f "$TMP" "$TMP.list" "$ROOT/applying.lock"' EXIT`,
      'vx_stream() { cat "$DIR"/p.* | gunzip | head -c 1234567; }',
      `vx_stream | docker run --rm -i ${IMG} sh -c 'tar -tf -; r=$?; cat >/dev/null; exit $r' > "$TMP.list" 2>/dev/null || { echo "invalid archive" >&2; exit 72; }`,
    ]);
    expect(s).toContain(`if vx_stream | docker run --rm -i -v '${VOL}':/data ${IMG} sh -c 'cd /data && find . -mindepth 1 -delete; tar -xf -; r=$?; cat >/dev/null; exit $r'; then`);
    expect(s).not.toContain("--no-same-owner");
    expect(s).toContain(`E=$(docker run --rm -v '${VOL}':/data:ro ${IMG} sh -c 'find /data -mindepth 1 ! -type s | wc -l | tr -d " "')`);
    expect(s).toContain(`[ "$E" = "42" ] || { echo "entry count mismatch" >&2; exit 68; }`);
    expect(s.split("\n").slice(-3)).toEqual([': > "$ROOT/applied"', 'echo "TUGRA_VX_APPLY_OK entries=$E"', 'rm -rf "$DIR"']);
    expect(s).not.toContain("PG_VERSION");
    expect(s).toContain("exit 71");
    expect(s).toContain("exit 70");
  });

  it("db-data: excludes postmaster.pid from the entry count and checks PG_VERSION", () => {
    const s = buildMigrationApplyScript({ ...base, excludes: ["postmaster.pid"], expectPgMajor: "16" });
    expect(s).toContain("find /data -mindepth 1 ! -type s ! -path /data/postmaster.pid | wc -l");
    expect(s).toContain(`V=$(docker run --rm -v '${VOL}':/data:ro ${IMG} cat /data/PG_VERSION | tr -d ' \\r\\n')`);
    expect(s).toContain(`[ "$V" = "16" ] || { echo "postgresql version mismatch" >&2; exit 69; }`);
    expect(s.indexOf("PG_VERSION")).toBeLessThan(s.indexOf('"$ROOT/applied"'));
  });

  it("the exit-code map extends the restore contract without changing it", () => {
    expect(MIGRATION_EXIT).toEqual({ noParts: 67, entryMismatch: 68, pgVersion: 69 });
  });

  it("validates EVERY value before it is interpolated (injection fuzz)", () => {
    const evil = ["a'b", "a b", "$(id)", "a;b", "a`b`", "a\nb", "a|b", "../x", "", "a&b", '"x"'];
    for (const v of evil) {
      expect(() => buildMigrationApplyScript({ ...base, transferId: v })).toThrow();
      expect(() => buildMigrationApplyScript({ ...base, dockerVolume: v })).toThrow();
      expect(() => buildMigrationApplyScript({ ...base, restoreId: v })).toThrow();
      expect(() => buildMigrationApplyScript({ ...base, excludes: [v] })).toThrow();
      expect(() => buildMigrationApplyScript({ ...base, expectPgMajor: v })).toThrow();
      expect(() => buildMigrationWipeDestScript(v)).toThrow();
      expect(() => buildMigrationWipeDestScript(VOL, v)).toThrow();
      expect(() => buildMigrationStateProbeScript(v)).toThrow();
      expect(() => buildMigrationCleanupScript(v)).toThrow();
      expect(() => buildMigrationPartStatScript(v, 0)).toThrow();
    }
    for (const n of [-1, 1.5, NaN, Number.POSITIVE_INFINITY, 2 ** 60]) {
      expect(() => buildMigrationApplyScript({ ...base, expectedEntries: n })).toThrow();
      expect(() => buildMigrationApplyScript({ ...base, rawBytes: n })).toThrow();
    }
    expect(() => buildMigrationApplyScript({ ...base, rawBytes: 0 })).toThrow();
    expect(() => buildMigrationPartStatScript(ID, 100_000)).toThrow();
    expect(() => migrationRestoreId(ID, 0)).toThrow();
    expect(migrationRestoreId(ID, 12)).toBe(`vx${ID}12`);
    expect(migrationRestoreId(ID, 12)).toMatch(/^[A-Za-z0-9_]{1,80}$/);
  });
});

describe("state probe / wipe / cleanup / part stat (golden)", () => {
  it("state probe is read-only and prints one line", () => {
    const s = buildMigrationStateProbeScript(ID);
    expect(s).toContain(`ROOT=/etc/tugra/app-moves/${ID}`);
    expect(s).toContain('echo "TUGRA_VX_STATE running=$R applied=$A parts=$P rb=$B"');
    expect(s).not.toMatch(/\brm\b|\bmkdir\b|docker (run|pull|volume rm)/);
  });

  it("wipe-dest is the plain find -delete in a helper; with a transfer id it adds the label-checked snapshot removal", () => {
    expect(buildMigrationWipeDestScript(VOL)).toBe(["set -e", `docker run --rm -v '${VOL}':/data ${IMG} sh -c 'cd /data && find . -mindepth 1 -delete'`].join("\n"));
    const w = buildMigrationWipeDestScript(VOL, ID);
    expect(w).toContain(`case "$lb" in vx${ID}*) docker volume rm "$v"`);
    expect(w.trimEnd().endsWith("exit 0")).toBe(true);
  });

  it("cleanup removes the staging dir and label-checked snapshots and always prints the end marker", () => {
    const c = buildMigrationCleanupScript(ID);
    expect(c.split("\n")[0]).toBe("set +e");
    expect(c).toContain(`rm -rf /etc/tugra/app-moves/${ID}`);
    expect(c.trimEnd().endsWith("echo TUGRA_VX_CLEANUP_DONE")).toBe(true);
  });

  it("part stat addresses the staged file by name", () => {
    expect(buildMigrationPartStatScript(ID, 7)).toContain(`F=/etc/tugra/app-moves/${ID}/0/p.00007`);
  });
});

describe("parsers (single-hit rule, fail closed)", () => {
  it("apply marker: exactly one whole line with entries", () => {
    expect(parseMigrationApplyOk("noise\nTUGRA_VX_APPLY_OK entries=12\n")).toBe(12);
    expect(parseMigrationApplyOk("")).toBeNull();
    expect(parseMigrationApplyOk("TUGRA_VX_APPLY_OK entries=1\nTUGRA_VX_APPLY_OK entries=1")).toBeNull();
    expect(parseMigrationApplyOk("TUGRA_VX_APPLY_OK entries=x")).toBeNull();
    expect(parseMigrationApplyOk("TUGRA_VX_APPLY_OK entries=1 extra")).toBeNull();
    expect(parseMigrationApplyOk("  TUGRA_VX_APPLY_OK entries=1")).toBeNull(); // only a whole line at column 0 counts
  });
  it("state probe: exactly one line; zero, two or malformed -> null", () => {
    expect(parseMigrationStateProbe("TUGRA_VX_STATE running=1 applied=0 parts=12 rb=1")).toEqual({ running: true, applied: false, parts: 12, rollbackVolume: true });
    for (const bad of ["", "TUGRA_VX_STATE running=1 applied=0 parts=12 rb=1\nTUGRA_VX_STATE running=0 applied=0 parts=0 rb=0", "TUGRA_VX_STATE running=2 applied=0 parts=1 rb=0", "TUGRA_VX_STATE running=1 applied=0 parts=-1 rb=0", "TUGRA_VX_STATE running=1"]) {
      expect(parseMigrationStateProbe(bad)).toBeNull();
    }
  });
});
