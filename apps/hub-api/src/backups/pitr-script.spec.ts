import { buildPitrPreflightScript, buildPitrVerifyScript, buildWalSpoolPurgeScript, parsePitrVerify, pitrExitHint } from "./pitr-script";
import type { DbSpec } from "../databases/database-script";

const spec: DbSpec = {
  id: "db1",
  engine: "POSTGRES",
  image: "postgres:16",
  port: 5432,
  hostPort: null,
  credentials: { username: "tugra", password: "s3cr3tPw", database: "appdb" },
};

describe("pitr-script", () => {
  describe("buildPitrPreflightScript", () => {
    const s = buildPitrPreflightScript(spec);

    it("fails loud BEFORE any mutation: running check, readiness, one settings round-trip", () => {
      expect(s.startsWith("set -e")).toBe(true);
      expect(s).toContain("docker inspect -f '{{.State.Running}}' tugra_db_db1");
      expect(s).toContain("exit 3"); // not running
      expect(s).toContain("tugra: postgres not ready"); // shared readiness prelude
      expect(s).toContain("-tAF'|'"); // single psql round trip, archive_command last
      expect(s).toContain("cut -d'|' -f5-"); // a user archive_command containing '|' survives
    });

    it("maps each refusal to a distinct exit code with an actionable message", () => {
      expect(s).toMatch(/Postgres 10 or newer[^\n]*exit 15/);
      // the hub's LSN → segment-name math is 16 MiB-only: a --wal-segsize cluster is refused before any mutation
      expect(s).toContain("wal_segment_size");
      expect(s).toMatch(/\[ "\$SEG" = "16MB" \] \|\|[^\n]*exit 16/);
      expect(pitrExitHint(16, "preflight")).toMatch(/16MB/);
      expect(s).toMatch(/wal_level=minimal[^\n]*exit 4/);
      expect(s).toMatch(/already has its own archive_command[^\n]*exit 12/);
      expect(s).toMatch(/under 1 GiB free[^\n]*exit 5/i);
      expect(s).toMatch(/spool is not empty[^\n]*exit 14/);
      expect(s).toMatch(/could not pull postgres:16[^\n]*exit 13/);
    });

    it("tolerates OUR OWN archive_command (re-enable) but refuses a foreign one", () => {
      // the case arm for an existing archive_command whitelists the /tugra-wal/ spool command and an empty value
      expect(s).toContain('case "$AC" in */tugra-wal/*) ;; "") ;;');
    });

    it("pre-pulls the image so a registry outage never strikes after the container is removed", () => {
      expect(s).toContain("docker pull 'postgres:16'");
      // the pull is the LAST probe before the ok marker
      expect(s.indexOf("docker pull")).toBeLessThan(s.indexOf("TUGRA_PITR_PREFLIGHT ok"));
    });

    it("passes the password only via PGPASSWORD env (never bare on argv)", () => {
      expect(s).toContain("PGPASSWORD='s3cr3tPw'");
      expect(s).not.toMatch(/ s3cr3tPw( |$)/m);
    });
  });

  describe("buildPitrVerifyScript", () => {
    const s = buildPitrVerifyScript(spec);

    it("proves the recreate armed archiving (archive_mode on, wal_level not minimal, OUR archive_command)", () => {
      expect(s).toContain('[ "$AM" = on ]');
      expect(s).toContain('[ "$WL" != minimal ]');
      expect(s).toContain('case "$AC" in */tugra-wal/*) ;;');
      expect(s).toMatch(/not the PITR spool command[^\n]*exit 4/);
    });

    it("baselines pg_stat_archiver INSIDE the run (counters reset on crash recovery)", () => {
      expect(s).toContain("A0=$(P \"SELECT archived_count FROM pg_stat_archiver\")");
      expect(s).toContain("F0=$(P \"SELECT failed_count FROM pg_stat_archiver\")");
    });

    it("emits WAL, captures the CURRENT segment name BEFORE pg_switch_wal, then switches", () => {
      const emit = s.indexOf("pg_logical_emit_message");
      const name = s.indexOf("pg_walfile_name(pg_current_wal_lsn())");
      const sw = s.indexOf("pg_switch_wal()");
      expect(emit).toBeGreaterThan(-1);
      expect(name).toBeGreaterThan(emit);
      expect(sw).toBeGreaterThan(name); // switch AFTER the name is captured (a switch may name the NEXT file)
    });

    it("polls the host spool for the FINAL file (never *.part) and surfaces archiver failures as they happen", () => {
      expect(s).toContain(`[ -s '/etc/tugra/wal/db1'/"$W" ]`);
      expect(s).not.toContain(".part");
      expect(s).toMatch(/archive_command failed[^\n]*exit 9/);
      // the diagnostic must actually name the segment: a column select without FROM would silently yield ""
      expect(s).toContain("SELECT coalesce(last_failed_wal,'') FROM pg_stat_archiver");
      expect(s).toMatch(/not in the host spool[^\n]*exit 11/);
      expect(s).toMatch(/no WAL archived within 60s[^\n]*exit 10/);
      expect(s).toContain('echo "TUGRA_PITR_VERIFY ok wal=$W"');
    });

    it("starts with the container-running check (RUNNING row ≠ healthy postgres)", () => {
      expect(s).toContain("docker inspect -f '{{.State.Running}}' tugra_db_db1");
    });
  });

  describe("parsePitrVerify", () => {
    it("reads the segment from the ok marker; null on any failure output", () => {
      expect(parsePitrVerify("junk\nTUGRA_PITR_VERIFY ok wal=000000010000000000000003\n")).toEqual({ wal: "000000010000000000000003" });
      expect(parsePitrVerify("tugra: no WAL archived within 60s")).toBeNull();
      expect(parsePitrVerify("")).toBeNull();
    });
  });

  describe("buildWalSpoolPurgeScript", () => {
    it("removes exactly the per-db spool and nothing else", () => {
      const s = buildWalSpoolPurgeScript("db1");
      expect(s).toBe("rm -rf '/etc/tugra/wal/db1' 2>/dev/null || true");
      expect(s).not.toContain("docker");
    });
  });

  describe("pitrExitHint", () => {
    it("gives phase-specific, actionable text and a generic fallback", () => {
      expect(pitrExitHint(4, "preflight")).toMatch(/wal_level/);
      expect(pitrExitHint(14, "preflight")).toMatch(/spool/);
      expect(pitrExitHint(9, "verify")).toMatch(/archive_command/);
      expect(pitrExitHint(11, "verify")).toMatch(/bind mount/);
      expect(pitrExitHint(99, "verify")).toMatch(/exit 99/);
      expect(pitrExitHint(null, "preflight")).toMatch(/exit \?/);
    });
  });
});
