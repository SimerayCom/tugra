import { buildImporterDump, canDumpOverSsh } from "./db-dump";

const creds = { username: "u", password: "pw", database: "orders" };

describe("canDumpOverSsh", () => {
  it("supports every engine Tugra can back up (all but LibSQL)", () => {
    for (const e of ["POSTGRES", "MYSQL", "MARIADB", "MONGO", "REDIS", "KEYDB", "DRAGONFLY", "CLICKHOUSE"] as const) {
      expect(canDumpOverSsh(e)).toBe(true);
    }
    expect(canDumpOverSsh("LIBSQL")).toBe(false);
  });
});

describe("buildImporterDump (reuses Tugra's own dump builder)", () => {
  it("postgres → pg_dump -Fc, format pg_custom, against the given container", () => {
    const p = buildImporterDump("POSTGRES", "co-pg-1", creds);
    expect(p.format).toBe("pg_custom");
    expect(p.command).toContain("docker exec -e PGPASSWORD='pw' co-pg-1 pg_dump -Fc");
    expect(p.command).toContain("-U 'u' 'orders'");
  });

  it("mariadb uses mariadb-dump (NOT mysqldump — works on MariaDB 11+ images)", () => {
    const p = buildImporterDump("MARIADB", "co-mar-1", creds);
    expect(p.format).toBe("sql");
    expect(p.command).toContain("mariadb-dump");
    expect(p.command).not.toContain("mysqldump");
  });

  it("mysql → mysqldump, format sql", () => {
    const p = buildImporterDump("MYSQL", "co-my-1", creds);
    expect(p.format).toBe("sql");
    expect(p.command).toContain("mysqldump");
  });

  it("mongo → mongodump --archive, format mongo_archive", () => {
    const p = buildImporterDump("MONGO", "co-mg-1", creds);
    expect(p.format).toBe("mongo_archive");
    expect(p.command).toContain("mongodump --username");
    expect(p.command).toContain("--archive");
  });

  it("redis-family → rdb via redis/keydb-cli", () => {
    expect(buildImporterDump("REDIS", "co-r-1", creds).format).toBe("rdb");
    expect(buildImporterDump("KEYDB", "co-k-1", creds).command).toContain("keydb-cli");
    expect(buildImporterDump("DRAGONFLY", "co-d-1", creds).format).toBe("rdb");
  });

  it("clickhouse → zip format", () => {
    expect(buildImporterDump("CLICKHOUSE", "co-ch-1", creds).format).toBe("clickhouse_zip");
  });

  it("escapes credentials (single-quote) — no shell break-out", () => {
    const p = buildImporterDump("POSTGRES", "co-pg-1", { username: "u", password: "x'; rm -rf / #", database: "d" });
    expect(p.command).toContain(`PGPASSWORD='x'\\''; rm -rf / #'`);
  });

  it("refuses LibSQL (no logical dump)", () => {
    expect(() => buildImporterDump("LIBSQL", "co-lib-1", creds)).toThrow(/manually/);
  });
});
