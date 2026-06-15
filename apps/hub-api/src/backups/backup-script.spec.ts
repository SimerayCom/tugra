import {
  backupFilename,
  backupPath,
  buildBackupScript,
  buildDeleteBackupScript,
  buildRestoreScript,
} from "./backup-script";
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

describe("backup-script", () => {
  describe("filenames / paths", () => {
    it("uses an engine-specific extension and a per-db directory", () => {
      expect(backupFilename("POSTGRES", "2026-06-16T10-00-00")).toBe("2026-06-16T10-00-00.sql");
      expect(backupFilename("MONGO", "t")).toBe("t.archive");
      expect(backupFilename("REDIS", "t")).toBe("t.rdb");
      expect(backupPath("db1", "t.sql")).toBe("/etc/tugra/backups/db1/t.sql");
    });
  });

  describe("buildBackupScript", () => {
    it("dumps via docker exec into a file and prints only the byte size", () => {
      const s = buildBackupScript(spec("POSTGRES"), "t.sql");
      expect(s).toContain("mkdir -p /etc/tugra/backups/db1");
      expect(s).toContain("docker exec -e PGPASSWORD='pw' tugra_db_db1 pg_dump -U 'tugra' 'appdb'");
      expect(s).toContain("> /etc/tugra/backups/db1/t.sql");
      expect(s).toContain("stat -c %s /etc/tugra/backups/db1/t.sql");
    });

    it("uses the right dump tool per engine", () => {
      expect(buildBackupScript(spec("MYSQL"), "t.sql")).toContain("mysqldump");
      expect(buildBackupScript(spec("MONGO"), "t.archive")).toContain("mongodump --username");
      const redis = buildBackupScript(spec("REDIS"), "t.rdb");
      expect(redis).toContain("redis-cli -a 'pw' --no-auth-warning SAVE");
      expect(redis).toContain("docker cp tugra_db_db1:/data/dump.rdb");
    });
  });

  describe("buildRestoreScript", () => {
    it("restores from the on-disk file per engine", () => {
      expect(buildRestoreScript(spec("POSTGRES"), "t.sql")).toContain("docker exec -i -e PGPASSWORD='pw' tugra_db_db1 psql -U 'tugra' -d 'appdb'");
      expect(buildRestoreScript(spec("MYSQL"), "t.sql")).toContain("mysql -u'tugra' 'appdb'");
      expect(buildRestoreScript(spec("MONGO"), "t.archive")).toContain("mongorestore");
      expect(buildRestoreScript(spec("REDIS"), "t.rdb")).toContain("docker cp /etc/tugra/backups/db1/t.rdb tugra_db_db1:/data/dump.rdb");
    });
  });

  describe("buildDeleteBackupScript", () => {
    it("removes a single backup file", () => {
      expect(buildDeleteBackupScript("db1", "t.sql")).toContain("rm -f /etc/tugra/backups/db1/t.sql");
    });
  });
});
