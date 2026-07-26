import {
  buildDatabaseRunScript,
  buildDbRemoveScript,
  connectionInfo,
  credentialEnv,
  engineCommand,
  enginePort,
  resolveImage,
  supportsBackup,
  type DbCredentials,
  type DbEngine,
  type DbSpec,
} from "./database-script";

const creds: DbCredentials = { username: "tugra", password: "p@ss", database: "appdb" };

function spec(engine: DbEngine, over: Partial<DbSpec> = {}): DbSpec {
  return {
    id: "db1",
    engine,
    image: resolveImage(engine),
    port: enginePort(engine),
    hostPort: null,
    credentials: creds,
    ...over,
  };
}

describe("database-script — extra engines (Dilim 17)", () => {
  it("resolves images/ports for the 4 new engines", () => {
    expect(resolveImage("MARIADB")).toBe("mariadb:11");
    expect(resolveImage("KEYDB")).toBe("eqalpha/keydb:latest");
    expect(resolveImage("DRAGONFLY")).toBe("docker.dragonflydb.io/dragonflydb/dragonfly:latest");
    expect(resolveImage("CLICKHOUSE")).toBe("clickhouse/clickhouse-server:24");
    expect(enginePort("MARIADB")).toBe(3306);
    expect(enginePort("CLICKHOUSE")).toBe(9000);
  });

  it("maps credentials per engine", () => {
    expect(credentialEnv("MARIADB", creds)).toMatchObject({ MARIADB_ROOT_PASSWORD: "p@ss", MARIADB_USER: "tugra" });
    expect(credentialEnv("CLICKHOUSE", creds)).toMatchObject({ CLICKHOUSE_PASSWORD: "p@ss", CLICKHOUSE_DB: "appdb" });
    expect(credentialEnv("KEYDB", creds)).toEqual({});
    expect(credentialEnv("DRAGONFLY", creds)).toEqual({});
  });

  it("server command per redis-family engine", () => {
    expect(engineCommand("KEYDB", creds)).toContain("keydb-server --requirepass");
    expect(engineCommand("DRAGONFLY", creds)).toContain("--requirepass");
    expect(engineCommand("MARIADB", creds)).toBe("");
  });

  it("connection URIs: redis-family + clickhouse + mariadb", () => {
    expect(connectionInfo(spec("KEYDB")).uri).toBe("redis://:p@ss@tugra_db_db1:6379");
    expect(connectionInfo(spec("DRAGONFLY")).uri).toBe("redis://:p@ss@tugra_db_db1:6379");
    expect(connectionInfo(spec("MARIADB")).uri).toBe("mysql://tugra:p@ss@tugra_db_db1:3306/appdb");
    expect(connectionInfo(spec("CLICKHOUSE")).uri).toBe("clickhouse://tugra:p@ss@tugra_db_db1:9000/appdb");
  });

  it("supportsBackup: every engine now supported (incl. Dragonfly + ClickHouse)", () => {
    expect(supportsBackup("MARIADB")).toBe(true);
    expect(supportsBackup("KEYDB")).toBe(true);
    expect(supportsBackup("DRAGONFLY")).toBe(true);
    expect(supportsBackup("CLICKHOUSE")).toBe(true);
  });

  it("run script joins tugra-net + volume for a new engine", () => {
    const s = buildDatabaseRunScript(spec("MARIADB"));
    expect(s).toContain("--network tugra-net");
    expect(s).toContain("-v tugra_dbv_db1:/var/lib/mysql");
    expect(s).toContain("mariadb:11");
  });
});

describe("database-script", () => {
  describe("resolveImage / enginePort", () => {
    it("resolves default images and ports per engine", () => {
      expect(resolveImage("POSTGRES")).toBe("postgres:16");
      expect(resolveImage("MYSQL")).toBe("mysql:8");
      expect(resolveImage("REDIS")).toBe("redis:7-alpine");
      expect(resolveImage("MONGO")).toBe("mongo:7");
      expect(resolveImage("POSTGRES", "15")).toBe("postgres:15");
      expect(enginePort("POSTGRES")).toBe(5432);
      expect(enginePort("REDIS")).toBe(6379);
    });
  });

  describe("credentialEnv", () => {
    it("maps credentials to each engine's bootstrap env", () => {
      expect(credentialEnv("POSTGRES", creds)).toMatchObject({ POSTGRES_PASSWORD: "p@ss", POSTGRES_DB: "appdb" });
      expect(credentialEnv("MYSQL", creds)).toMatchObject({ MYSQL_ROOT_PASSWORD: "p@ss", MYSQL_USER: "tugra" });
      expect(credentialEnv("MONGO", creds)).toMatchObject({ MONGO_INITDB_ROOT_PASSWORD: "p@ss" });
      expect(credentialEnv("REDIS", creds)).toEqual({});
    });
  });

  describe("engineCommand", () => {
    it("passes the password to redis via --requirepass; empty for others", () => {
      expect(engineCommand("REDIS", creds)).toContain("--requirepass");
      expect(engineCommand("POSTGRES", creds)).toBe("");
    });
  });

  describe("buildDatabaseRunScript", () => {
    it("joins tugra-net, mounts a named volume, no traefik/domain", () => {
      const s = buildDatabaseRunScript(spec("POSTGRES"));
      expect(s).toContain("docker network create tugra-net");
      expect(s).toContain("--network tugra-net");
      expect(s).toContain("-v tugra_dbv_db1:/var/lib/postgresql/data");
      expect(s).toContain("--name tugra_db_db1");
      expect(s).toContain("-e 'POSTGRES_PASSWORD=p@ss'");
      expect(s).not.toContain("traefik");
      expect(s).not.toContain("certresolver");
    });

    it("adds a host port mapping only when requested", () => {
      expect(buildDatabaseRunScript(spec("POSTGRES"))).not.toContain("-p ");
      expect(buildDatabaseRunScript(spec("POSTGRES", { hostPort: 5455 }))).toContain("-p 5455:5432");
    });

    it("appends the redis requirepass command after the image", () => {
      const s = buildDatabaseRunScript(spec("REDIS"));
      expect(s).toContain("redis:7-alpine");
      expect(s).toContain("redis-server --requirepass");
    });
  });

  describe("buildDbRemoveScript", () => {
    it("removes the container and its volume (data dropped)", () => {
      const s = buildDbRemoveScript({ id: "db1" });
      expect(s).toContain("docker rm -f tugra_db_db1");
      expect(s).toContain("docker volume rm tugra_dbv_db1");
    });
  });

  describe("resource limits + health-check", () => {
    it("adds --memory/--cpus/--health-cmd flags when set", () => {
      const s = buildDatabaseRunScript(
        spec("POSTGRES", { memoryMb: 512, cpus: 0.5, healthCmd: "pg_isready -U tugra || exit 1" }),
      );
      expect(s).toContain("--memory 512m");
      expect(s).toContain("--cpus 0.5");
      expect(s).toContain("--health-cmd 'pg_isready -U tugra || exit 1'");
      expect(s).toContain("--health-interval=30s");
    });

    it("omits limit flags when unset", () => {
      const s = buildDatabaseRunScript(spec("POSTGRES"));
      expect(s).not.toContain("--memory");
      expect(s).not.toContain("--cpus");
      expect(s).not.toContain("--health-cmd");
    });
  });

  describe("connectionInfo", () => {
    it("builds an engine-specific URI with the container name as host", () => {
      expect(connectionInfo(spec("POSTGRES")).uri).toBe("postgresql://tugra:p@ss@tugra_db_db1:5432/appdb");
      expect(connectionInfo(spec("MYSQL")).uri).toBe("mysql://tugra:p@ss@tugra_db_db1:3306/appdb");
      expect(connectionInfo(spec("REDIS")).uri).toBe("redis://:p@ss@tugra_db_db1:6379");
      expect(connectionInfo(spec("MONGO")).uri).toBe("mongodb://tugra:p@ss@tugra_db_db1:27017");
      expect(connectionInfo(spec("POSTGRES")).internalHost).toBe("tugra_db_db1");
    });
  });

  describe("LIBSQL (sqld)", () => {
    it("resolves the sqld image + port + defaults", () => {
      expect(resolveImage("LIBSQL")).toBe("ghcr.io/tursodatabase/libsql-server:latest");
      expect(enginePort("LIBSQL")).toBe(8080);
    });

    it("has no credential env and no server command (runs on sqld defaults)", () => {
      expect(credentialEnv("LIBSQL", creds)).toEqual({});
      expect(engineCommand("LIBSQL", creds)).toBe("");
    });

    it("builds a credential-free HTTP connection URI (no built-in auth in v1)", () => {
      expect(connectionInfo(spec("LIBSQL")).uri).toBe("http://tugra_db_db1:8080");
    });

    it("has no dump/restore backup pipeline", () => {
      expect(supportsBackup("LIBSQL")).toBe(false);
    });

    it("runs on the internal network with a persistent volume and no credential -e flags", () => {
      const s = buildDatabaseRunScript(spec("LIBSQL"));
      expect(s).toContain("--network tugra-net");
      expect(s).toContain("tugra_dbv_db1:/var/lib/sqld");
      expect(s).not.toContain("-e "); // no credential env for sqld
    });
  });
});
