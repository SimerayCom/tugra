import {
  backupFilename,
  backupPath,
  buildBackupScript,
  buildDeleteBackupScript,
  buildImportScript,
  buildRestoreScript,
} from "./backup-script";
import { LOCAL_DEST, type DestinationSpec } from "./destination";
import { resolveImage, enginePort, type DbEngine, type DbSpec } from "../databases/database-script";

function spec(engine: DbEngine): DbSpec {
  return {
    id: "db1",
    engine,
    image: resolveImage(engine),
    port: enginePort(engine),
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

describe("backup-script", () => {
  describe("backupFilename", () => {
    it("adds .gz, and .gpg when the destination encrypts", () => {
      expect(backupFilename("POSTGRES", "2026-06-16T10-00-00", LOCAL_DEST)).toBe("2026-06-16T10-00-00.sql.gz");
      expect(backupFilename("POSTGRES", "t", s3Encrypted)).toBe("t.sql.gz.gpg");
      expect(backupFilename("MONGO", "t", LOCAL_DEST)).toBe("t.archive.gz");
      expect(backupFilename("REDIS", "t", LOCAL_DEST)).toBe("t.rdb.gz");
    });
  });

  describe("buildBackupScript — LOCAL (regression)", () => {
    it("dumps to a file on disk and prints the byte size", () => {
      const s = buildBackupScript(spec("POSTGRES"), "t.sql.gz", LOCAL_DEST);
      expect(s).toContain("mkdir -p /etc/tugra/backups/db1");
      expect(s).toContain("pg_dump -U 'tugra' 'appdb'");
      expect(s).toContain("| gzip");
      expect(s).toContain("> /etc/tugra/backups/db1/t.sql.gz");
      expect(s).toContain("stat -c %s /etc/tugra/backups/db1/t.sql.gz");
      expect(s).not.toContain("mc pipe");
      expect(s).not.toContain("gpg");
    });
  });

  describe("buildBackupScript — S3", () => {
    it("streams the dump to S3 via mc pipe with creds in MC_HOST", () => {
      const s = buildBackupScript(spec("POSTGRES"), "t.sql.gz", s3Dest);
      expect(s).toContain("command -v mc"); // install-on-demand
      expect(s).toContain("MC_HOST_tdest=");
      expect(s).toContain("mc pipe tdest/my-bucket/tugra/db1/t.sql.gz");
      expect(s).toContain("mc stat --json tdest/my-bucket/tugra/db1/t.sql.gz");
      expect(s).not.toContain("gpg"); // encryption off
    });

    it("inserts a gpg AES-256 step when the destination encrypts", () => {
      const s = buildBackupScript(spec("POSTGRES"), "t.sql.gz.gpg", s3Encrypted);
      // pipeline is wrapped in `sh -c '...'`, so inner quotes are escaped — just
      // assert the gpg symmetric AES-256 step and the passphrase are present.
      expect(s).toContain("gpg --batch --yes --passphrase");
      expect(s).toContain("--symmetric --cipher-algo AES256");
      expect(s).toContain("mc pipe");
    });

    it("streams every engine to stdout (no temp dump file in the container)", () => {
      expect(buildBackupScript(spec("MYSQL"), "t", s3Dest)).toContain("mysqldump");
      expect(buildBackupScript(spec("MONGO"), "t", s3Dest)).toContain("mongodump --username");
      expect(buildBackupScript(spec("REDIS"), "t", s3Dest)).toContain("redis-cli");
    });

    it("dumps MySQL/MariaDB with consistent-snapshot flags (no table locks)", () => {
      const my = buildBackupScript(spec("MYSQL"), "t", s3Dest);
      expect(my).toContain("mysqldump --single-transaction --quick --no-tablespaces");
      const maria = buildBackupScript(spec("MARIADB"), "t", s3Dest);
      expect(maria).toContain("mariadb-dump --single-transaction --quick");
    });
  });

  describe("buildRestoreScript", () => {
    it("LOCAL: cat file | gunzip | psql", () => {
      const s = buildRestoreScript(spec("POSTGRES"), "t.sql.gz", LOCAL_DEST);
      expect(s).toContain("cat /etc/tugra/backups/db1/t.sql.gz");
      expect(s).toContain("gunzip");
      expect(s).toContain("docker exec -i -e PGPASSWORD='pw' tugra_db_db1 psql -U 'tugra' -d 'appdb'");
    });

    it("S3 + encrypted: mc cat | gpg -d | gunzip | psql", () => {
      const s = buildRestoreScript(spec("POSTGRES"), "t.sql.gz.gpg", s3Encrypted);
      expect(s).toContain("mc cat tdest/my-bucket/tugra/db1/t.sql.gz.gpg");
      expect(s).toContain("--decrypt");
      expect(s).toContain("gunzip");
      expect(s).toContain("psql -U 'tugra'");
    });

    it("Redis restore replaces the rdb file and restarts", () => {
      const s = buildRestoreScript(spec("REDIS"), "t.rdb.gz", LOCAL_DEST);
      expect(s).toContain("docker cp /tmp/tugra_db_db1.rdb tugra_db_db1:/data/dump.rdb");
      expect(s).toContain("docker restart tugra_db_db1");
    });
  });

  describe("buildImportScript", () => {
    it("curls the URL and pipes through gunzip into the engine restore", () => {
      const s = buildImportScript(spec("POSTGRES"), "https://x/d.sql.gz", { encrypted: false, key: "", gzip: true });
      expect(s).toContain("curl -fsSL 'https://x/d.sql.gz'");
      expect(s).toContain("gunzip");
      expect(s).toContain("docker exec -i -e PGPASSWORD='pw' tugra_db_db1 psql -U 'tugra' -d 'appdb'");
      expect(s).not.toContain("--decrypt");
    });

    it("adds gpg --decrypt when encrypted, and skips gunzip when gzip=false", () => {
      const enc = buildImportScript(spec("POSTGRES"), "https://x/d.sql.gz.gpg", { encrypted: true, key: "pp", gzip: true });
      expect(enc).toContain("--decrypt");
      const plain = buildImportScript(spec("POSTGRES"), "https://x/d.sql", { encrypted: false, key: "", gzip: false });
      expect(plain).not.toContain("gunzip");
      expect(plain).toContain("curl -fsSL 'https://x/d.sql'");
    });
  });

  describe("buildDeleteBackupScript", () => {
    it("removes a local file or an S3 object", () => {
      expect(buildDeleteBackupScript("db1", "t.sql.gz", LOCAL_DEST)).toContain("rm -f /etc/tugra/backups/db1/t.sql.gz");
      expect(buildDeleteBackupScript("db1", "t.sql.gz", s3Dest)).toContain("mc rm tdest/my-bucket/tugra/db1/t.sql.gz");
    });
  });

  describe("backupPath", () => {
    it("builds a per-db path", () => {
      expect(backupPath("db1", "t.sql.gz")).toBe("/etc/tugra/backups/db1/t.sql.gz");
    });
  });

  describe("extra engines (Dilim 17)", () => {
    it("MariaDB dumps via mariadb-dump and restores via mariadb client", () => {
      expect(buildBackupScript(spec("MARIADB"), "t.sql.gz", LOCAL_DEST)).toContain("mariadb-dump --single-transaction --quick -u'tugra'");
      expect(buildRestoreScript(spec("MARIADB"), "t.sql.gz", LOCAL_DEST)).toContain("mariadb -u'tugra' 'appdb'");
    });

    it("KeyDB dumps via keydb-cli SAVE + rdb", () => {
      const s = buildBackupScript(spec("KEYDB"), "t.rdb.gz", LOCAL_DEST);
      // wrapped in `sh -c '...'` so inner quotes are escaped — assert tool + SAVE
      expect(s).toContain("keydb-cli");
      expect(s).toContain("--no-auth-warning SAVE");
      expect(s).toContain("cat /data/dump.rdb");
    });

    it("Dragonfly / ClickHouse backup scripts throw (unsupported)", () => {
      expect(() => buildBackupScript(spec("DRAGONFLY"), "t.rdb.gz", LOCAL_DEST)).toThrow(/not supported/);
      expect(() => buildBackupScript(spec("CLICKHOUSE"), "t.sql.gz", LOCAL_DEST)).toThrow(/not supported/);
    });
  });
});
