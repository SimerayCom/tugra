import {
  backupFilename,
  backupPath,
  buildBackupScript,
  buildBackupExportUrlScript,
  buildDeleteBackupScript,
  buildImportScript,
  buildRestoreScript,
  scrubRestoreOutput,
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
      expect(backupFilename("POSTGRES", "2026-06-16T10-00-00", LOCAL_DEST)).toBe("2026-06-16T10-00-00.dump.gz");
      expect(backupFilename("POSTGRES", "t", s3Encrypted)).toBe("t.dump.gz.gpg");
      expect(backupFilename("MONGO", "t", LOCAL_DEST)).toBe("t.archive.gz");
      expect(backupFilename("REDIS", "t", LOCAL_DEST)).toBe("t.rdb.gz");
      expect(backupFilename("DRAGONFLY", "t", LOCAL_DEST)).toBe("t.rdb.gz");
      expect(backupFilename("CLICKHOUSE", "t", LOCAL_DEST)).toBe("t.zip.gz");
    });
  });

  describe("buildBackupScript — LOCAL (regression)", () => {
    it("dumps to a file on disk and prints the byte size", () => {
      const s = buildBackupScript(spec("POSTGRES"), "t.dump.gz", LOCAL_DEST);
      expect(s).toContain("mkdir -p /etc/tugra/backups/db1");
      expect(s).toContain("pg_dump -Fc -Z0 --no-owner --no-acl -U 'tugra' 'appdb'");
      expect(s).toContain("| gzip");
      expect(s).toContain("> /etc/tugra/backups/db1/t.dump.gz");
      expect(s).toContain("stat -c %s /etc/tugra/backups/db1/t.dump.gz");
      expect(s).not.toContain("mc pipe");
      expect(s).not.toContain("gpg");
    });
  });

  describe("buildBackupScript — S3", () => {
    it("streams the dump to S3 via mc pipe with creds in MC_HOST", () => {
      const s = buildBackupScript(spec("POSTGRES"), "t.dump.gz", s3Dest);
      expect(s).toContain("command -v mc"); // install-on-demand
      expect(s).toContain("MC_HOST_tdest=");
      expect(s).toContain("mc pipe tdest/my-bucket/tugra/db1/t.dump.gz");
      expect(s).toContain("mc stat --json tdest/my-bucket/tugra/db1/t.dump.gz");
      expect(s).not.toContain("gpg"); // encryption off
    });

    it("inserts a gpg AES-256 step when the destination encrypts", () => {
      const s = buildBackupScript(spec("POSTGRES"), "t.dump.gz.gpg", s3Encrypted);
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

    it("Dragonfly: SAVE RDB single-file snapshot, reply must be OK (no -e), password via REDISCLI_AUTH", () => {
      const s = buildBackupScript(spec("DRAGONFLY"), "t", s3Dest);
      expect(s).toContain("redis-cli --no-auth-warning SAVE RDB tugra_backup"); // reply captured + checked
      expect(s).not.toContain("redis-cli -e"); // the Dragonfly build can exit 0 with -e → don't rely on it
      expect(s).toContain('[ "$r" = OK ]'); // snapshot read ONLY when SAVE replied OK
      expect(s).toContain("cat /data/tugra_backup.rdb");
      expect(s).toContain("REDISCLI_AUTH=pw");
      expect(s).not.toContain("redis-cli -a"); // password never on redis-cli's own argv
    });

    it("ClickHouse: BACKUP … TO File under allowed_path, double-quoted identifier (no backtick substitution)", () => {
      const s = buildBackupScript(spec("CLICKHOUSE"), "t", s3Dest);
      expect(s).toContain("BACKUP DATABASE");
      expect(s).toContain('\\"appdb\\"'); // identifier double-quote-quoted (NOT backtick → no shell cmd-subst)
      expect(s).not.toContain(`${String.fromCharCode(96)}appdb${String.fromCharCode(96)}`); // no raw `appdb`
      expect(s).toContain("/var/lib/clickhouse/backups/tugra_backup.zip"); // default backups.allowed_path
      expect(s).not.toContain("Disk("); // File backend, not the config-dependent Disk backend
      // connect explicitly as the managed user (default-user has no grant) + wait for the server to accept
      expect(s).toContain('--user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD"');
      expect(s).toContain('--query "SELECT 1"'); // readiness poll before the BACKUP
    });

    it("dumps MySQL/MariaDB with consistent-snapshot flags (no table locks) over forced TCP", () => {
      const my = buildBackupScript(spec("MYSQL"), "t", s3Dest);
      expect(my).toContain("mysqldump --single-transaction --quick --no-tablespaces");
      expect(my).toContain("--protocol=TCP -h127.0.0.1"); // default unix-socket path is unreliable across images
      const maria = buildBackupScript(spec("MARIADB"), "t", s3Dest);
      expect(maria).toContain("mariadb-dump --single-transaction --quick");
      expect(maria).toContain("--protocol=TCP -h127.0.0.1");
    });
  });

  describe("buildRestoreScript", () => {
    it("new custom-format .dump: cat | gunzip | pg_restore --clean --if-exists (idempotent)", () => {
      const s = buildRestoreScript(spec("POSTGRES"), "t.dump.gz", LOCAL_DEST);
      expect(s).toContain("cat /etc/tugra/backups/db1/t.dump.gz");
      expect(s).toContain("gunzip");
      expect(s).toContain("pg_restore --no-owner --clean --if-exists --single-transaction -U 'tugra' -d 'appdb'");
      expect(s).not.toContain(" psql "); // custom format never uses psql
    });

    it("legacy plain .sql backups still restore via psql, now atomic + fail-loud (back-compat)", () => {
      const s = buildRestoreScript(spec("POSTGRES"), "t.sql.gz", LOCAL_DEST);
      expect(s).toContain("cat /etc/tugra/backups/db1/t.sql.gz");
      expect(s).toContain("psql -v ON_ERROR_STOP=1 --single-transaction -U 'tugra' -d 'appdb'");
      expect(s).not.toContain("pg_restore");
    });

    it("S3 + encrypted custom restore: mc cat | gpg -d | gunzip | pg_restore", () => {
      const s = buildRestoreScript(spec("POSTGRES"), "t.dump.gz.gpg", s3Encrypted);
      expect(s).toContain("mc cat tdest/my-bucket/tugra/db1/t.dump.gz.gpg");
      expect(s).toContain("--decrypt");
      expect(s).toContain("gunzip");
      expect(s).toContain("pg_restore --no-owner --clean --if-exists --single-transaction");
    });

    it("Redis restore kills (no shutdown-save) before swapping the rdb, then waits for PONG", () => {
      const s = buildRestoreScript(spec("REDIS"), "t.rdb.gz", LOCAL_DEST);
      expect(s).toContain("head -c5 /tmp/tugra_db_db1.rdb | grep -q REDIS"); // signature guard before the swap
      expect(s).toContain("docker kill tugra_db_db1"); // SIGKILL → no graceful SAVE clobbering our file
      expect(s).toContain("docker cp /tmp/tugra_db_db1.rdb tugra_db_db1:/data/dump.rdb");
      expect(s).toContain("docker start tugra_db_db1");
      expect(s).toContain("grep -q PONG"); // readiness: a failed boot surfaces instead of looking like success
      expect(s).not.toContain("docker restart"); // restart would SAVE the wiped DB over the restored file
      // kill must precede the copy (so the file isn't overwritten on shutdown)
      expect(s.indexOf("docker kill")).toBeLessThan(s.indexOf("docker cp"));
    });

    it("Dragonfly restore validates the RDB signature BEFORE DFLY LOAD (no wipe on a bad file) + reply must be OK", () => {
      const s = buildRestoreScript(spec("DRAGONFLY"), "t.rdb.gz", LOCAL_DEST);
      expect(s).toContain("gunzip");
      expect(s).toContain("cat > /data/tugra_restore.rdb");
      expect(s).toContain("head -c5 /data/tugra_restore.rdb | grep -q REDIS"); // signature check before the destructive load
      expect(s).toContain("redis-cli --no-auth-warning DFLY LOAD /data/tugra_restore.rdb");
      expect(s).not.toContain("redis-cli -e"); // the Dragonfly build can exit 0 with -e → don't rely on it
      expect(s).toContain('[ "$r" = OK ]'); // success requires the load reply to be exactly OK
      // the signature gate must precede DFLY LOAD (which flushes-then-loads)
      expect(s.indexOf("grep -q REDIS")).toBeLessThan(s.indexOf("DFLY LOAD"));
      expect(s).not.toContain("docker restart");
    });

    it("ClickHouse restore stages to a temp DB then swaps (never destroy-before-validate)", () => {
      const s = buildRestoreScript(spec("CLICKHOUSE"), "t.zip.gz", LOCAL_DEST);
      expect(s).toContain("gunzip");
      expect(s).toContain("cat > /var/lib/clickhouse/backups/tugra_restore.zip");
      expect(s).toContain("RESTORE DATABASE");
      expect(s).toContain("__tugra_restore_tmp"); // restores into a temp DB first
      expect(s).toContain("RENAME DATABASE"); // then swaps temp → real
      expect(s).toContain("FROM File(");
      expect(s).toContain('\\"appdb\\"'); // double-quoted identifier, not backtick
      // the real DB is dropped only AFTER a successful restore-to-temp (real DROP is the LAST DROP)
      expect(s.indexOf("RESTORE DATABASE")).toBeLessThan(s.lastIndexOf("DROP DATABASE"));
    });
  });

  describe("buildImportScript", () => {
    it("curls the URL and pipes through gunzip into the engine restore", () => {
      const s = buildImportScript(spec("POSTGRES"), "https://x/d.sql.gz", { encrypted: false, key: "", gzip: true });
      expect(s).toContain("curl -fsSL 'https://x/d.sql.gz'");
      expect(s).toContain("gunzip");
      // external dump → fail-loud psql (ON_ERROR_STOP) but NOT --single-transaction:
      // the dump may carry its own BEGIN/COMMIT or a CREATE DATABASE.
      expect(s).toContain("psql -v ON_ERROR_STOP=1 -U 'tugra' -d 'appdb'");
      expect(s).not.toContain("--single-transaction");
      expect(s).not.toContain("--decrypt");
    });

    it("adds gpg --decrypt when encrypted, and skips gunzip when gzip=false", () => {
      const enc = buildImportScript(spec("POSTGRES"), "https://x/d.sql.gz.gpg", { encrypted: true, key: "pp", gzip: true });
      expect(enc).toContain("--decrypt");
      const plain = buildImportScript(spec("POSTGRES"), "https://x/d.sql", { encrypted: false, key: "", gzip: false });
      expect(plain).not.toContain("gunzip");
      expect(plain).toContain("curl -fsSL 'https://x/d.sql'");
    });

    it("Postgres: a plain-SQL URL uses psql (sql-loose, non-atomic)", () => {
      const s = buildImportScript(spec("POSTGRES"), "https://x/d.sql.gz", { encrypted: false, key: "", gzip: true });
      expect(s).toContain("psql -v ON_ERROR_STOP=1 -U 'tugra'");
      expect(s).not.toContain("pg_restore");
      expect(s).not.toContain("--single-transaction"); // external SQL — not forced-atomic
    });

    it("Postgres: a .dump(.gz) migration URL uses pg_restore (custom format), even with a presigned query string", () => {
      const s = buildImportScript(spec("POSTGRES"), "https://s3/b/db1/2026.dump.gz?X-Amz-Signature=sig", { encrypted: false, key: "", gzip: true });
      expect(s).toContain("pg_restore --no-owner --clean --if-exists --single-transaction");
      expect(s).not.toContain("psql");
    });

    it("a look-alike .dumped URL is NOT treated as custom format (precise match)", () => {
      const s = buildImportScript(spec("POSTGRES"), "https://x/mydb.dumped.gz", { encrypted: false, key: "", gzip: true });
      expect(s).not.toContain("pg_restore");
      expect(s).toContain("psql");
    });

    it("pgFormat:'custom' forces pg_restore for a foreign dump whose extension lies (Coolify .dmp)", () => {
      const s = buildImportScript(spec("POSTGRES"), "https://x/backup.dmp.gz", { encrypted: false, key: "", gzip: true, pgFormat: "custom" });
      expect(s).toContain("pg_restore --no-owner --clean --if-exists --single-transaction");
      expect(s).not.toContain(" psql ");
    });

    it("pgFormat:'sql' forces psql even when the URL ends in .dump (explicit override beats the sniff)", () => {
      const s = buildImportScript(spec("POSTGRES"), "https://x/2026.dump.gz", { encrypted: false, key: "", gzip: true, pgFormat: "sql" });
      expect(s).toContain("psql -v ON_ERROR_STOP=1 -U 'tugra'");
      expect(s).not.toContain("pg_restore");
    });

    it("a .dump only in the query string does NOT flip to custom (path-anchored detection)", () => {
      const s = buildImportScript(spec("POSTGRES"), "https://host/plain-export.sql?ref=https://o/x.dump", { encrypted: false, key: "", gzip: false });
      expect(s).not.toContain("pg_restore");
      expect(s).toContain("psql");
    });

    it("non-Postgres engines ignore the pg mode (mysql client regardless of .dump)", () => {
      const s = buildImportScript(spec("MYSQL"), "https://x/2026.dump.gz", { encrypted: false, key: "", gzip: true });
      expect(s).toContain("mysql -u'tugra'");
      expect(s).not.toContain("pg_restore");
    });
  });

  describe("buildBackupExportUrlScript", () => {
    it("builds an mc share download presigned-URL command (shq target) against the backup object", () => {
      const s = buildBackupExportUrlScript("db1", "2026.dump.gz", s3Dest, "24h");
      expect(s).toContain("command -v mc"); // MC_INSTALL
      expect(s).toContain("mc share download --expire '24h' --json 'tdest/my-bucket/tugra/db1/2026.dump.gz'");
    });
    it("refuses a LOCAL destination (no presignable object)", () => {
      expect(() => buildBackupExportUrlScript("db1", "2026.dump.gz", LOCAL_DEST, "24h")).toThrow(/S3/);
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

  describe("scrubRestoreOutput", () => {
    it("redacts customer row data from restore errors but keeps the diagnostic scaffolding", () => {
      const out = [
        'pg_restore: error: could not execute query',
        'ERROR:  duplicate key value violates unique constraint "users_email_key"',
        'DETAIL:  Key (email)=(alice@example.com) already exists.',
        'CONTEXT:  COPY users, line 42: "1,alice@example.com,$2b$10$secrethash"',
        "STATEMENT:  INSERT INTO users VALUES ('alice@example.com','secret')",
      ].join("\n");
      const s = scrubRestoreOutput(out);
      // sensitive values gone
      expect(s).not.toContain("alice@example.com");
      expect(s).not.toContain("secrethash");
      expect(s).not.toContain("secret')");
      expect(s).toContain("<redacted>");
      // diagnostic scaffolding kept
      expect(s).toContain('unique constraint "users_email_key"');
      expect(s).toContain("duplicate key value");
    });

    it("masks a MySQL Duplicate entry value and caps to the last 2KB", () => {
      expect(scrubRestoreOutput("Duplicate entry 'bob@x.io' for key 'PRIMARY'")).toContain("Duplicate entry '<redacted>' for key 'PRIMARY'");
      expect(scrubRestoreOutput("x".repeat(5000)).length).toBe(2000);
    });
  });

  describe("extra engines (Dilim 17)", () => {
    it("MariaDB dumps via mariadb-dump and restores via mariadb client", () => {
      expect(buildBackupScript(spec("MARIADB"), "t.sql.gz", LOCAL_DEST)).toContain("mariadb-dump --single-transaction --quick -u'tugra'");
      expect(buildRestoreScript(spec("MARIADB"), "t.sql.gz", LOCAL_DEST)).toContain("mariadb -u'tugra' --protocol=TCP -h127.0.0.1 'appdb'");
    });

    it("KeyDB dumps via keydb-cli SAVE + rdb", () => {
      const s = buildBackupScript(spec("KEYDB"), "t.rdb.gz", LOCAL_DEST);
      // wrapped in `sh -c '...'` so inner quotes are escaped — assert tool + SAVE
      expect(s).toContain("keydb-cli");
      expect(s).toContain("--no-auth-warning SAVE");
      expect(s).toContain("cat /data/dump.rdb");
    });

    it("Dragonfly / ClickHouse backup + restore are now supported (build without throwing)", () => {
      expect(() => buildBackupScript(spec("DRAGONFLY"), "t.rdb.gz", LOCAL_DEST)).not.toThrow();
      expect(() => buildBackupScript(spec("CLICKHOUSE"), "t.zip.gz", LOCAL_DEST)).not.toThrow();
      expect(() => buildRestoreScript(spec("DRAGONFLY"), "t.rdb.gz", LOCAL_DEST)).not.toThrow();
      expect(() => buildRestoreScript(spec("CLICKHOUSE"), "t.zip.gz", LOCAL_DEST)).not.toThrow();
    });
  });
});
