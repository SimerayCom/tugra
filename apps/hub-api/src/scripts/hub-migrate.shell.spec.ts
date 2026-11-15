import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Shell checks for the destination-keys branches of scripts/hub-migrate.sh. The script is SOURCED (the dispatch is
 * skipped under HUB_MIGRATE_SOURCED=1) and `compose` is replaced by a stub, so no docker is needed.
 */
const SCRIPT = resolve(__dirname, "../../../../scripts/hub-migrate.sh");

function run(body: string, env: Record<string, string> = {}): { code: number; out: string; err: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "hubmig-"));
  const r = spawnSync("bash", ["-c", `set -euo pipefail; HUB_MIGRATE_SOURCED=1 . "${SCRIPT}"; ${body}`], {
    env: { ...process.env, ...env, DIR: dir },
    encoding: "utf8",
  });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr, dir };
}
const mode = (p: string) => (statSync(p).mode & 0o777).toString(8);
const stub = (rc: number, writeJson: boolean) =>
  `compose() { ${writeJson ? 'printf \'{"v":1,"destinations":[]}\\n\'' : ":"}; return ${rc}; }`;

describe("hub-migrate.sh export_destination_keys (pack)", () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const go = (body: string, env?: Record<string, string>) => {
    const r = run(body, env);
    dirs.push(r.dir);
    return r;
  };

  it("rc 0: keeps the file (mode 600) and sets DEST_KEYS=1", () => {
    const r = go(`${stub(0, true)}; export_destination_keys "$DIR"; echo "DK=$DEST_KEYS"`);
    expect(r.code).toBe(0);
    expect(r.out).toContain("DK=1");
    expect(mode(join(r.dir, "destination-keys.json"))).toBe("600");
  });

  it("rc 2 (incomplete): a LOUD failure by default, file removed, DEST_KEYS=0", () => {
    const r = go(`${stub(2, true)}; rc=0; export_destination_keys "$DIR" || rc=$?; echo "RC=$rc DK=$DEST_KEYS"`);
    expect(r.out).toContain("RC=2 DK=0");
    expect(r.err).toMatch(/INCOMPLETE/);
    expect(existsSync(join(r.dir, "destination-keys.json"))).toBe(false);
  });

  it("rc 2 with --allow-incomplete-keys: warns, keeps the file (mode 600), DEST_KEYS=1, returns 0", () => {
    const r = go(`${stub(2, true)}; ALLOW_INCOMPLETE_KEYS=1; export_destination_keys "$DIR"; echo "DK=$DEST_KEYS"`);
    expect(r.code).toBe(0);
    expect(r.out).toContain("DK=1");
    expect(r.err).toMatch(/INCOMPLETE/);
    expect(mode(join(r.dir, "destination-keys.json"))).toBe("600");
  });

  it.each([1, 127])("rc %i (hub-api down or other): warns, never aborts, no file, DEST_KEYS=0", (rc) => {
    const r = go(`${stub(rc, true)}; export_destination_keys "$DIR"; echo "DK=$DEST_KEYS"`);
    expect(r.code).toBe(0);
    expect(r.out).toContain("DK=0");
    expect(r.err).toMatch(/could not export destination keys/);
    expect(existsSync(join(r.dir, "destination-keys.json"))).toBe(false);
  });

  it("rc 2 with an EMPTY file is treated as a plain failure (nothing to keep), not a half manifest", () => {
    const r = go(`${stub(2, false)}; export_destination_keys "$DIR"; echo "DK=$DEST_KEYS"`);
    expect(r.code).toBe(0);
    expect(r.out).toContain("DK=0");
  });
});

describe("hub-migrate.sh restore_destination_keys (unpack)", () => {
  it("copies next to .env with mode 600, even over an existing looser-mode file", () => {
    const r = run(
      `mkdir -p "$DIR/repo" "$DIR/bundle"; ENV_FILE="$DIR/repo/.env"; echo '{"v":1}' > "$DIR/bundle/destination-keys.json"; ` +
        `echo old > "$DIR/repo/destination-keys.json"; chmod 644 "$DIR/repo/destination-keys.json"; restore_destination_keys "$DIR/bundle"`,
    );
    try {
      expect(r.code).toBe(0);
      const dst = join(r.dir, "repo", "destination-keys.json");
      expect(readFileSync(dst, "utf8")).toContain('"v":1');
      expect(mode(dst)).toBe("600");
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
  });

  it("a failing cp only warns (never aborts the restore)", () => {
    const r = run(
      `mkdir -p "$DIR/bundle"; ENV_FILE="$DIR/missing-dir/.env"; echo '{}' > "$DIR/bundle/destination-keys.json"; restore_destination_keys "$DIR/bundle"; echo after`,
    );
    try {
      expect(r.code).toBe(0);
      expect(r.out).toContain("after");
      expect(r.err).toMatch(/could not restore destination-keys.json/);
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
  });

  it("no destination-keys.json in the bundle is a silent no-op", () => {
    const r = run(`mkdir -p "$DIR/bundle"; ENV_FILE="$DIR/.env"; restore_destination_keys "$DIR/bundle"; echo done`);
    try {
      expect(r.code).toBe(0);
      expect(r.out).toContain("done");
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
  });
});
