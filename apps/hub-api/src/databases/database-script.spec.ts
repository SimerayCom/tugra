import {
  buildDatabaseRunScript,
  reservedDbEnvKeys,
  buildDbRemoveScript,
  connectionInfo,
  publicConnectionUri,
  credentialEnv,
  engineCommand,
  enginePort,
  resolveImage,
  supportsBackup,
  walHostDir,
  pgArchiveCommand,
  pgArchiveArgs,
  WAL_CONTAINER_DIR,
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

  it("connection URIs: redis-family + clickhouse + mariadb (password percent-encoded)", () => {
    expect(connectionInfo(spec("KEYDB")).uri).toBe("redis://:p%40ss@tugra_db_db1:6379");
    expect(connectionInfo(spec("DRAGONFLY")).uri).toBe("redis://:p%40ss@tugra_db_db1:6379");
    expect(connectionInfo(spec("MARIADB")).uri).toBe("mysql://tugra:p%40ss@tugra_db_db1:3306/appdb");
    expect(connectionInfo(spec("CLICKHOUSE")).uri).toBe("clickhouse://tugra:p%40ss@tugra_db_db1:9000/appdb");
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

  describe("reservedDbEnvKeys", () => {
    it("reserves the credential keys PLUS the image's auth-override vars", () => {
      const pg = reservedDbEnvKeys("POSTGRES");
      expect(pg.has("POSTGRES_PASSWORD")).toBe(true); // credential key
      expect(pg.has("POSTGRES_HOST_AUTH_METHOD")).toBe(true); // disables password auth
      expect(pg.has("POSTGRES_PASSWORD_FILE")).toBe(true); // re-sources the password
      expect(pg.has("TZ")).toBe(false); // a legitimate var stays allowed
      expect(reservedDbEnvKeys("MYSQL").has("MYSQL_RANDOM_ROOT_PASSWORD")).toBe(true);
      expect(reservedDbEnvKeys("MARIADB").has("MYSQL_ALLOW_EMPTY_PASSWORD")).toBe(true); // mariadb honours MYSQL_*
      expect(reservedDbEnvKeys("MONGO").has("MONGO_INITDB_ROOT_PASSWORD_FILE")).toBe(true);
      expect(reservedDbEnvKeys("CLICKHOUSE").has("CLICKHOUSE_SKIP_USER_SETUP")).toBe(true);
      // Redis-family carry auth via server args, not env — nothing to reserve.
      expect(reservedDbEnvKeys("REDIS").size).toBe(0);
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

    it("caps json-file logs so a chatty database can't fill the host disk", () => {
      expect(buildDatabaseRunScript(spec("POSTGRES"))).toContain("--log-driver json-file --log-opt max-size=10m --log-opt max-file=3");
    });

    it("appends the redis requirepass command after the image", () => {
      const s = buildDatabaseRunScript(spec("REDIS"));
      expect(s).toContain("redis:7-alpine");
      expect(s).toContain("redis-server --requirepass");
    });

    it("injects user env vars (shell-quoted) BEFORE the engine credential env so creds always win", () => {
      const s = buildDatabaseRunScript(spec("POSTGRES", { env: { TZ: "Europe/Istanbul", PGDATA: "/data" } }));
      expect(s).toContain("-e 'TZ=Europe/Istanbul'");
      expect(s).toContain("-e 'PGDATA=/data'");
      // user var appears before the managed credential var (later -e flags win in docker)
      expect(s.indexOf("-e 'TZ=Europe/Istanbul'")).toBeLessThan(s.indexOf("-e 'POSTGRES_PASSWORD=p@ss'"));
    });

    it("shell-quotes a malicious user env value (no injection)", () => {
      const s = buildDatabaseRunScript(spec("POSTGRES", { env: { EVIL: "x'; rm -rf /; '" } }));
      expect(s).toContain("-e 'EVIL=x'\\''; rm -rf /; '\\'''");
    });

    it("emits no user env flags when none are set", () => {
      const s = buildDatabaseRunScript(spec("POSTGRES"));
      // only the single credential block's flags; nothing extra
      expect(s).toContain("-e 'POSTGRES_PASSWORD=p@ss'");
    });

    it("mounts extra volumes under per-database derived names (alongside the managed data volume)", () => {
      const s = buildDatabaseRunScript(spec("POSTGRES", { volumes: [{ name: "cache", path: "/cache" }, { name: "cfg", path: "/etc/x" }] }));
      expect(s).toContain("-v tugra_dbv_db1:/var/lib/postgresql/data"); // managed data volume
      expect(s).toContain("-v tugra_dbv_db1_cache:/cache");
      expect(s).toContain("-v tugra_dbv_db1_cfg:/etc/x");
    });
  });

  describe("buildDbRemoveScript", () => {
    it("removes the container and its volume (data dropped) by default", () => {
      const s = buildDbRemoveScript({ id: "db1" });
      expect(s).toContain("docker rm -f tugra_db_db1");
      expect(s).toContain("docker volume rm tugra_dbv_db1");
    });

    it("keeps the data volume when keepVolume is set (only the container is removed)", () => {
      const s = buildDbRemoveScript({ id: "db1" }, { keepVolume: true });
      expect(s).toContain("docker rm -f tugra_db_db1");
      expect(s).not.toContain("docker volume rm");
    });

    it("also removes extra named volumes so a deleted database orphans none", () => {
      const s = buildDbRemoveScript({ id: "db1", volumes: [{ name: "cache", path: "/cache" }] });
      expect(s).toContain("docker volume rm tugra_dbv_db1 ");
      expect(s).toContain("docker volume rm tugra_dbv_db1_cache ");
    });

    it("keepVolume leaves the extra volumes too", () => {
      const s = buildDbRemoveScript({ id: "db1", volumes: [{ name: "cache", path: "/cache" }] }, { keepVolume: true });
      expect(s).not.toContain("docker volume rm");
    });

    it("walSpool: reclaims the host WAL dir only when opted in (byte-identical otherwise)", () => {
      expect(buildDbRemoveScript({ id: "db1" })).not.toContain("/etc/tugra/wal/");
      const s = buildDbRemoveScript({ id: "db1" }, { walSpool: true });
      expect(s).toContain("rm -rf /etc/tugra/wal/db1");
    });

    it("walSpool is a no-op under keepVolume (recreate keeps the WAL)", () => {
      const s = buildDbRemoveScript({ id: "db1" }, { walSpool: true, keepVolume: true });
      expect(s).not.toContain("/etc/tugra/wal/");
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
      expect(connectionInfo(spec("POSTGRES")).uri).toBe("postgresql://tugra:p%40ss@tugra_db_db1:5432/appdb");
      expect(connectionInfo(spec("MYSQL")).uri).toBe("mysql://tugra:p%40ss@tugra_db_db1:3306/appdb");
      expect(connectionInfo(spec("REDIS")).uri).toBe("redis://:p%40ss@tugra_db_db1:6379");
      expect(connectionInfo(spec("MONGO")).uri).toBe("mongodb://tugra:p%40ss@tugra_db_db1:27017");
      expect(connectionInfo(spec("POSTGRES")).internalHost).toBe("tugra_db_db1");
    });
  });

  describe("publicConnectionUri", () => {
    it("swaps the host and port for the server's public address + mapped host port", () => {
      // same encoding as the internal URI, but reachable from outside Tugra's network
      expect(publicConnectionUri(spec("POSTGRES"), "203.0.113.5", 15432)).toBe("postgresql://tugra:p%40ss@203.0.113.5:15432/appdb");
      expect(publicConnectionUri(spec("REDIS"), "203.0.113.5", 16379)).toBe("redis://:p%40ss@203.0.113.5:16379");
      expect(publicConnectionUri(spec("MONGO"), "203.0.113.5", 17017)).toBe("mongodb://tugra:p%40ss@203.0.113.5:17017");
      expect(publicConnectionUri(spec("LIBSQL"), "203.0.113.5", 18080)).toBe("http://203.0.113.5:18080");
    });

    it("brackets an IPv6 literal host", () => {
      expect(publicConnectionUri(spec("POSTGRES"), "2001:db8::1", 15432)).toBe("postgresql://tugra:p%40ss@[2001:db8::1]:15432/appdb");
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

  describe("PITR (5.4) — WAL archiving run builder", () => {
    // Frozen pre-slice output. These GOLDENS are the real regression guard for "the PITR layer is inert when
    // off": a `toBe` against the whole script fails on ANY drift (a stray space, a non-filtered "" flag, an
    // ordering change), which a self-comparison or `not.toContain` cannot catch. POSTGRES is the engine PITR
    // targets; REDIS exercises the non-empty engine-command slot (the other place the command token is built).
    const PG_GOLDEN =
      "set -e\n" +
      "docker network create tugra-net 2>/dev/null || true\n" +
      "docker pull 'postgres:16'\n" +
      "docker rm -f tugra_db_db1 2>/dev/null || true\n" +
      "docker run -d --name tugra_db_db1 --restart unless-stopped --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 --network tugra-net -v tugra_dbv_db1:/var/lib/postgresql/data -e 'POSTGRES_USER=tugra' -e 'POSTGRES_PASSWORD=p@ss' -e 'POSTGRES_DB=appdb' 'postgres:16'\n" +
      "docker ps --filter name=tugra_db_db1 --format '{{.Status}}'";
    const REDIS_GOLDEN =
      "set -e\n" +
      "docker network create tugra-net 2>/dev/null || true\n" +
      "docker pull 'redis:7-alpine'\n" +
      "docker rm -f tugra_db_db1 2>/dev/null || true\n" +
      "docker run -d --name tugra_db_db1 --restart unless-stopped --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 --network tugra-net -v tugra_dbv_db1:/data 'redis:7-alpine' redis-server --requirepass 'p@ss'\n" +
      "docker ps --filter name=tugra_db_db1 --format '{{.Status}}'";

    it("is byte-identical to the pre-slice script when pitr is off/undefined (POSTGRES + REDIS goldens)", () => {
      expect(buildDatabaseRunScript(spec("POSTGRES"))).toBe(PG_GOLDEN);
      expect(buildDatabaseRunScript(spec("POSTGRES", { pitr: false }))).toBe(PG_GOLDEN);
      expect(buildDatabaseRunScript(spec("REDIS"))).toBe(REDIS_GOLDEN);
      // ...and the whole WAL layer leaves zero trace on the off-path.
      expect(PG_GOLDEN).not.toContain("archive_mode");
      expect(PG_GOLDEN).not.toContain("/tugra-wal");
      expect(PG_GOLDEN).not.toContain("/etc/tugra/wal");
    });

    it("never arms PITR for a non-Postgres engine even when the flag is set", () => {
      const mysql = buildDatabaseRunScript(spec("MYSQL"));
      expect(buildDatabaseRunScript(spec("MYSQL", { pitr: true }))).toBe(mysql);
      expect(mysql).not.toContain("archive_mode");
    });

    it("on Postgres: mounts the host WAL spool, arms archive_mode, and fixes the mount's owner", () => {
      const s = buildDatabaseRunScript(spec("POSTGRES", { pitr: true }));
      // bind-mount host spool → container dir (NOT a named volume, so the shipper reads it on the host path)
      expect(s).toContain(`-v ${walHostDir("db1")}:${WAL_CONTAINER_DIR}`);
      // spool created + locked down before the container mounts it
      expect(s).toContain("mkdir -p /etc/tugra/wal/db1 && chmod 700 /etc/tugra/wal/db1");
      // archive args ride the engine-command slot
      expect(s).toContain("-c archive_mode=on");
      expect(s).toContain("-c archive_timeout=300");
      expect(s).toContain("archive_command=");
      // postgres runs as its own uid; the root-owned bind is chowned after the container is up
      expect(s).toContain(`docker exec -u root tugra_db_db1 chown postgres:postgres ${WAL_CONTAINER_DIR}`);
    });

    it("archive_command is idempotent (already-archived → exit 0), durable (fsync) and atomic (.part then rename)", () => {
      const cmd = pgArchiveCommand();
      expect(cmd).toContain(`[ -f "${WAL_CONTAINER_DIR}/%f" ] && exit 0`);
      expect(cmd).toContain(`${WAL_CONTAINER_DIR}/%f.part`);
      // the segment is fsync'd BEFORE the rename publishes it — otherwise a power loss could leave a truncated
      // segment the idempotence guard treats as archived forever (silent WAL-chain break).
      expect(cmd).toMatch(/sync "[^"]*%f\.part".*&& mv .*%f\.part.*%f"/);
    });

    it("pgArchiveArgs shell-quotes the archive_command as a single -c token", () => {
      const args = pgArchiveArgs();
      // the command contains spaces/&&/; — it must arrive as ONE quoted arg, never split across -c flags
      expect(args).toContain("-c archive_command='");
      expect(args.match(/-c archive_mode=on/g)).toHaveLength(1);
    });
  });
});
