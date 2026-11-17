import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFreezeTemplate, freezePrelude } from "./host-freeze-script";
import { containerNameMatches } from "./source-scripts";

/**
 * The remote freeze script's container matcher, run for real under every POSIX shell on the box (dash is /bin/sh on the CI
 * Ubuntu runners) against a fake docker. It must agree with the TS matcher `containerNameMatches` on both Coolify naming
 * generations: the legacy `<uuid>-<digits>` and the 4.7 `<uuid>-YYYYMMDDTHHMMSS`.
 */
const UUID = "x8kc0sw4cw0c0ooc0o4gg0ck";
const ID = (n: number): string => n.toString(16).padStart(64, "0");
const SHELLS = ["dash", "bash", "sh"].filter((s) => spawnSync("sh", ["-c", `command -v ${s}`]).status === 0);

function freezeOutput(shell: string, names: string[]): { matched: string[]; unresolved: boolean } {
  const dir = mkdtempSync(join(tmpdir(), "tugra-frz-"));
  try {
    writeFileSync(join(dir, "ps.txt"), names.map((n, i) => `${ID(i + 1)}|${n}|ghcr.io/x/web:1||running\n`).join(""));
    writeFileSync(
      join(dir, "docker"),
      ['#!/bin/sh', 'case "$1" in', '  ps) cat "$FAKE_DIR/ps.txt" ;;', '  inspect) n=$(grep "^$4|" "$FAKE_DIR/ps.txt" | head -n 1 | cut -d"|" -f2); printf "/%s\\tghcr.io/x/web:1\\n" "$n" ;;', "  *) exit 0 ;;", "esac", ""].join("\n"),
    );
    chmodSync(join(dir, "docker"), 0o755);
    const script = [freezePrelude({ ref: "srv-a", runId: "run-aaaaaaaa", action: "freeze", items: [`app:srv-a:${UUID}`], graceSec: 5, allowUnresolved: true }), buildFreezeTemplate(join(dir, "root"))].join("\n");
    const file = join(dir, "freeze.sh");
    writeFileSync(file, script);
    const r = spawnSync(shell, [file], { encoding: "utf8", env: { PATH: `${dir}:/usr/bin:/bin`, FAKE_DIR: dir } });
    expect(r.status).toBe(0);
    const lines = r.stdout.split("\n");
    return {
      matched: lines.filter((l) => l.includes("\tTUGRA_CTR\t")).map((l) => l.split("\t")[5]),
      unresolved: lines.some((l) => l.includes("unresolved")),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("host freeze script: container name matcher", () => {
  const MATCH = [UUID, `${UUID}-170000000000`, `${UUID}-20261110T153012`, `${UUID}-000000`];
  const NEAR_MISS = [
    `${UUID}-pr-12`, // a preview container is not the app
    `${UUID}-12345`, // fewer than 6 digits
    `${UUID}-20261110t153012`, // lowercase t
    `${UUID}-20261110T1530`, // truncated time
    `${UUID}-20261110T153012x`, // trailing junk
    `${UUID}-20261110T153012-1`, // a second suffix
    `${UUID}-2026111T1530123`, // wrong digit split
    `${UUID}x-20261110T153012`, // another uuid sharing the prefix
    `web-${UUID}`, // only a SERVICE component may carry the uuid as a suffix
  ];

  it("found at least one shell to run under", () => {
    expect(SHELLS.length).toBeGreaterThan(0);
  });

  for (const shell of SHELLS) {
    it(`[${shell}] takes both naming generations and refuses every near miss`, () => {
      const r = freezeOutput(shell, [...MATCH, ...NEAR_MISS]);
      expect(r.matched).toEqual(MATCH);
      expect(r.unresolved).toBe(false);
    });
    it(`[${shell}] a host with only near misses leaves the item unresolved`, () => {
      const r = freezeOutput(shell, NEAR_MISS);
      expect(r.matched).toEqual([]);
      expect(r.unresolved).toBe(true);
    });
  }

  it("agrees with the TS matcher on every name above", () => {
    for (const n of [...MATCH, ...NEAR_MISS]) expect([n, containerNameMatches(n, UUID, "application")]).toEqual([n, MATCH.includes(n)]);
  });
});
