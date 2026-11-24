import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildMigratorRecipe, buildAllMigratorRecipes, MIGRATOR_ENGINES, MIGRATOR_UNSUPPORTED, RECIPE_VARS } from "./migrator-recipe";
import { ENGINES, type DbEngine } from "../databases/database-script";

describe("migrator-recipe", () => {
  describe("universal invariants (every engine)", () => {
    it.each(MIGRATOR_ENGINES)("%s: no inlined secret, docker-exec shaped, only known $TUGRA_SRC_* refs", (engine) => {
      const r = buildMigratorRecipe(engine);
      // never carries a sentinel (the drift guard) and never a plaintext credential on the argv
      expect(r.command).not.toContain("TUGRA_SENT_");
      expect(r.command.startsWith("docker exec ")).toBe(true);
      expect(r.command).not.toContain("\n"); // single line — the Go side rejects a newline

      // every $TUGRA_SRC_X reference is one of the four known container-side vars
      const refs = [...r.command.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);
      for (const ref of refs) {
        if (ref.startsWith("TUGRA_SRC_")) expect(RECIPE_VARS).toContain(ref);
      }

      // every `-e NAME` is either a known container-side var or declared in env (so the Go side can bind it)
      const eFlags = [...r.command.matchAll(/-e ([A-Za-z_][A-Za-z0-9_]*)\b/g)].map((m) => m[1]);
      const declared = new Set<string>([...RECIPE_VARS, ...r.env.map((e) => e.name)]);
      for (const name of eFlags) expect(declared.has(name)).toBe(true);

      // no `-e NAME='…'` or `-e NAME=…` inlined value survives (secrets go in by NAME only)
      expect(r.command).not.toMatch(/-e [A-Za-z_][A-Za-z0-9_]*=/);
      // the password is never a host-expanded ref — it travels only under a bound -e name
      expect(r.command).not.toContain("TUGRA_SRC_PW");
      // env `from` values are valid
      for (const e of r.env) expect(["user", "pw", "db"]).toContain(e.from);
    });
  });

  it("PostgreSQL: pg_dump custom format, password via -e PGPASSWORD (off argv)", () => {
    const r = buildMigratorRecipe("POSTGRES");
    expect(r.command).toBe(
      'docker exec -e PGPASSWORD "$TUGRA_SRC_CTR" pg_dump -Fc -Z0 --no-owner --no-acl -U "$TUGRA_SRC_USER" "$TUGRA_SRC_DB"',
    );
    expect(r.format).toBe("pg_custom");
    expect(r.pgFormat).toBe("custom");
    expect(r.env).toEqual([{ name: "PGPASSWORD", from: "pw" }]);
  });

  it("MySQL: mysqldump over TCP, password via -e MYSQL_PWD", () => {
    const r = buildMigratorRecipe("MYSQL");
    expect(r.command).toBe(
      'docker exec -e MYSQL_PWD "$TUGRA_SRC_CTR" mysqldump --single-transaction --quick --no-tablespaces -u"$TUGRA_SRC_USER" --protocol=TCP -h127.0.0.1 "$TUGRA_SRC_DB"',
    );
    expect(r.format).toBe("sql");
    expect(r.pgFormat).toBeUndefined();
    expect(r.env).toEqual([{ name: "MYSQL_PWD", from: "pw" }]);
  });

  it("MariaDB: mariadb-dump, password via -e MYSQL_PWD", () => {
    const r = buildMigratorRecipe("MARIADB");
    expect(r.command).toBe(
      'docker exec -e MYSQL_PWD "$TUGRA_SRC_CTR" mariadb-dump --single-transaction --quick -u"$TUGRA_SRC_USER" --protocol=TCP -h127.0.0.1 "$TUGRA_SRC_DB"',
    );
    expect(r.format).toBe("sql");
    expect(r.env).toEqual([{ name: "MYSQL_PWD", from: "pw" }]);
  });

  it.each([
    ["REDIS", "redis-cli", "REDIS SAVE failed"],
    ["KEYDB", "keydb-cli", "KEYDB SAVE failed"],
  ] as const)("%s: SAVE reply must be OK, password via REDISCLI_AUTH (never -a on argv)", (engine, cli, failMsg) => {
    const r = buildMigratorRecipe(engine as DbEngine);
    expect(r.command).toBe(
      `docker exec -e REDISCLI_AUTH "$TUGRA_SRC_CTR" sh -c 'r=$(${cli} --no-auth-warning SAVE 2>&1); if [ "$r" = OK ]; then cat /data/dump.rdb; else echo "${failMsg}: $r" >&2; exit 1; fi'`,
    );
    expect(r.format).toBe("rdb");
    expect(r.env).toEqual([{ name: "REDISCLI_AUTH", from: "pw" }]);
    expect(r.command).not.toContain(`${cli} -a`);
  });

  it("Dragonfly: single-file SAVE RDB, reply OK, password via REDISCLI_AUTH", () => {
    const r = buildMigratorRecipe("DRAGONFLY");
    expect(r.command).toBe(
      `docker exec -e REDISCLI_AUTH "$TUGRA_SRC_CTR" sh -c 'rm -f /data/tugra_backup.rdb; r=$(redis-cli --no-auth-warning SAVE RDB tugra_backup 2>&1); if [ "$r" = OK ]; then cat /data/tugra_backup.rdb; rc=0; else echo "dragonfly SAVE failed: $r" >&2; rc=1; fi; rm -f /data/tugra_backup.rdb; exit $rc'`,
    );
    expect(r.format).toBe("rdb");
    expect(r.env).toEqual([{ name: "REDISCLI_AUTH", from: "pw" }]);
  });

  it("LibSQL has no logical dump: it throws and stays flagged with a machine-readable reason", () => {
    expect(MIGRATOR_ENGINES).not.toContain("LIBSQL");
    expect(() => buildMigratorRecipe("LIBSQL")).toThrow(/not available/);
    expect(MIGRATOR_UNSUPPORTED.LIBSQL).toBe("no-logical-dump");
    expect(Object.keys(MIGRATOR_UNSUPPORTED)).toEqual(["LIBSQL"]);
  });

  describe("MongoDB and ClickHouse: bespoke recipes (their clients take the password on their own argv)", () => {
    const fixture = JSON.parse(readFileSync(join(__dirname, "../../test/fixtures/safe-db-scripts.json"), "utf8")) as Record<string, string>;

    it("MongoDB: the in-container script writes a 0600 config file; the password is only the bound -e TUGRA_DB_PW", () => {
      const r = buildMigratorRecipe("MONGO");
      // the golden is built from the fixture the Go migrator is pinned to as well (agent/internal/migrate/testdata/safe-db-scripts.json)
      expect(r.command).toBe(`docker exec -e TUGRA_DB_PW "$TUGRA_SRC_CTR" sh -c '${fixture.mongoDump}' tugra-mongo "$TUGRA_SRC_USER"`);
      expect(r.format).toBe("mongo_archive");
      expect(r.pgFormat).toBeUndefined();
      expect(r.env).toEqual([{ name: "TUGRA_DB_PW", from: "pw" }]);
      expect(r.command).not.toContain("--password");
      expect(r.command).toContain("mongodump --config");
    });

    it("ClickHouse: BACKUP DATABASE through a client config file; user and database are validated positional words", () => {
      const r = buildMigratorRecipe("CLICKHOUSE");
      expect(r.command).toBe(`docker exec -e TUGRA_DB_PW "$TUGRA_SRC_CTR" sh -c '${fixture.chDump}' tugra-clickhouse "$TUGRA_SRC_USER" "$TUGRA_SRC_DB"`);
      expect(r.format).toBe("clickhouse_zip");
      expect(r.env).toEqual([{ name: "TUGRA_DB_PW", from: "pw" }]);
      expect(r.command).toContain("--config-file");
      expect(r.command).not.toContain("--password");
      expect(r.command).toContain("BACKUP DATABASE");
    });

    it("is a copy: changing what one call returns never changes the next", () => {
      const a = buildMigratorRecipe("MONGO");
      a.env.push({ name: "X", from: "pw" });
      expect(buildMigratorRecipe("MONGO").env).toHaveLength(1);
    });
  });

  it("buildAllMigratorRecipes serves exactly the 8 argv-safe streamable engines", () => {
    const all = buildAllMigratorRecipes();
    expect(Object.keys(all).sort()).toEqual([...MIGRATOR_ENGINES].sort());
    expect(Object.keys(all)).toHaveLength(8);
    expect(all.LIBSQL).toBeUndefined();
  });

  it("every DbEngine is classified in EXACTLY one of streamable / unsupported (adding one forces a choice)", () => {
    const allEngines = Object.keys(ENGINES);
    const supported = new Set<string>(MIGRATOR_ENGINES);
    const unsupported = new Set<string>(Object.keys(MIGRATOR_UNSUPPORTED));
    for (const e of allEngines) {
      // XOR: in one set, never both, never neither (no silent fall-through to the "unsupported" default)
      expect(supported.has(e) !== unsupported.has(e)).toBe(true);
    }
    // neither set names an engine that is not a real DbEngine
    for (const e of [...supported, ...unsupported]) expect(allEngines).toContain(e);
  });
});
