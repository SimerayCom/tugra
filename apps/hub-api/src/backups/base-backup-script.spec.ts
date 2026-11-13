import { baseBackupFilename, baseNs, basebackupProducer, basebackupPrelude, buildBaseBackupScript, parseBaseMeta } from "./base-backup-script";
import { LOCAL_DEST, type DestinationSpec } from "./destination";
import { resolveImage, enginePort, type DbSpec } from "../databases/database-script";

function pgSpec(): DbSpec {
  return {
    id: "db1",
    engine: "POSTGRES",
    image: resolveImage("POSTGRES"),
    port: enginePort("POSTGRES"),
    hostPort: null,
    credentials: { username: "tugra", password: "pw", database: "appdb" },
  };
}

const s3Dest: DestinationSpec = {
  type: "S3",
  s3: { bucket: "my-bucket", region: "us-east-1", endpoint: "s3.amazonaws.com", accessKey: "AK", secretKey: "SK", prefix: "tugra" },
  encryption: { enabled: false, key: "" },
};
const s3Encrypted: DestinationSpec = { ...s3Dest, encryption: { enabled: true, key: "secretpass" } };

describe("base-backup-script", () => {
  describe("baseBackupFilename / baseNs", () => {
    it("is <ts>.basebackup.tar.gz, +.gpg when encrypted, and never contains .dump", () => {
      expect(baseBackupFilename("2026-11-14T10-00-00", LOCAL_DEST)).toBe("2026-11-14T10-00-00.basebackup.tar.gz");
      expect(baseBackupFilename("t", s3Encrypted)).toBe("t.basebackup.tar.gz.gpg");
      expect(baseBackupFilename("t", LOCAL_DEST)).not.toContain(".dump");
    });
    it("namespaces physical bases under <dbId>/base", () => {
      expect(baseNs("db1")).toBe("db1/base");
    });
  });

  describe("basebackupProducer", () => {
    const cmd = basebackupProducer("tugra_db_db1", { username: "tugra", password: "pw", database: "appdb" }, "tugra-db1-ts");
    it("runs pg_basebackup in the container as a single self-contained tar to stdout", () => {
      expect(cmd).toContain("docker exec -e PGPASSWORD='pw' tugra_db_db1 pg_basebackup");
      expect(cmd).toContain("-U 'tugra'");
      expect(cmd).toContain("-D -");
      expect(cmd).toContain("-Ft");
      expect(cmd).toContain("-X fetch"); // the only WAL mode valid with tar-to-stdout
      expect(cmd).not.toContain("-X stream");
      expect(cmd).toContain("-c fast"); // immediate checkpoint
      expect(cmd).toContain("-w"); // never prompt
      expect(cmd).toContain("-v"); // metadata on stderr
      expect(cmd).toContain("-l 'tugra-db1-ts'");
      expect(cmd).not.toContain(" -h "); // local socket
    });
    it("shell-escapes a quote-bearing password/username", () => {
      const c = basebackupProducer("c", { username: "o'brien", password: "p'w", database: "d" }, "l");
      expect(c).toContain("PGPASSWORD='p'\\''w'");
      expect(c).toContain("-U 'o'\\''brien'");
    });
  });

  describe("basebackupPrelude", () => {
    const creds = { username: "tugra", password: "pw", database: "appdb" };
    it("waits for readiness and preflights the binary, wal_level and tablespaces with distinct exit codes", () => {
      const p = basebackupPrelude("tugra_db_db1", creds, { local: false });
      expect(p).toContain("SELECT 1"); // readiness poll
      expect(p).toContain("command -v pg_basebackup");
      expect(p).toContain("exit 6");
      expect(p).toContain("wal_level"); // SHOW/read wal_level (SQL is single-quote-escaped inside sh -c)
      expect(p).toContain("exit 4"); // wal_level=minimal
      expect(p).toContain("pg_tablespace");
      expect(p).toContain("exit 7"); // extra tablespaces
    });
    it("adds a LOCAL-only disk-headroom guard (exit 5), absent for S3, that cannot abort the run", () => {
      const local = basebackupPrelude("c", creds, { local: true });
      const remote = basebackupPrelude("c", creds, { local: false });
      expect(local).toContain("df -Pk /etc/tugra/backups"); // POSIX-portable (not GNU -B1)
      expect(local).toContain("mkdir -p /etc/tugra/backups"); // the dir may not exist on a first LOCAL backup
      expect(local).toContain("|| true"); // best-effort: a df quirk must never abort under set -e/pipefail
      expect(local).toContain("exit 5");
      expect(local).not.toContain("-B1"); // the GNU-only flag is gone
      expect(remote).not.toContain("df -P");
      expect(remote).not.toContain("exit 5");
    });
  });

  describe("buildBaseBackupScript", () => {
    it("LOCAL: preflight → pg_basebackup | gzip > /etc/tugra/backups/db1/base/<f>, stat size LAST, no mc, no gpg", () => {
      const s = buildBaseBackupScript(pgSpec(), "t.basebackup.tar.gz", LOCAL_DEST, "ts");
      expect(s).toContain("set -o pipefail");
      expect(s).toContain("pg_basebackup");
      expect(s).toContain("mkdir -p /etc/tugra/backups/db1/base");
      expect(s).toContain("| gzip > /etc/tugra/backups/db1/base/t.basebackup.tar.gz");
      expect(s.trim().split("\n").pop()).toContain("stat -c %s /etc/tugra/backups/db1/base/t.basebackup.tar.gz");
      expect(s).not.toContain("mc pipe");
      expect(s).not.toContain("gpg");
    });
    it("S3: streams via mc pipe to <bucket>/tugra/db1/base/<f> inside bash -o pipefail, mc stat LAST", () => {
      const s = buildBaseBackupScript(pgSpec(), "t.basebackup.tar.gz", s3Dest, "ts");
      expect(s).toContain("bash -o pipefail -c");
      expect(s).toContain("mc pipe tdest/my-bucket/tugra/db1/base/t.basebackup.tar.gz");
      expect(s.trim().split("\n").pop()).toContain("mc stat --json tdest/my-bucket/tugra/db1/base/t.basebackup.tar.gz");
    });
    it("encrypted S3: gpg comes AFTER gzip in the pipe", () => {
      const s = buildBaseBackupScript(pgSpec(), "t.basebackup.tar.gz.gpg", s3Encrypted, "ts");
      expect(s).toMatch(/gzip \| gpg .*--symmetric --cipher-algo AES256/);
    });
  });

  describe("parseBaseMeta", () => {
    it("parses the -v start LSN + timeline, nulls on a miss", () => {
      const out = "pg_basebackup: initiating base backup, waiting for checkpoint to complete\npg_basebackup: write-ahead log start point: 0/2000028 on timeline 1\n12345";
      expect(parseBaseMeta(out)).toEqual({ startLsn: "0/2000028", timeline: 1 });
      expect(parseBaseMeta("no metadata here\n999")).toEqual({ startLsn: null, timeline: null });
      // start point without an explicit timeline → LSN captured, timeline null
      expect(parseBaseMeta("write-ahead log start point: 1/ABC\n5")).toEqual({ startLsn: "1/ABC", timeline: null });
    });
  });
});
