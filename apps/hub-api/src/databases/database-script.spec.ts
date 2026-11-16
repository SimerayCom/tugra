import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dataMountFor,
  pgDataLayout,
  pgMajorOfDb,
  pgWantsParentMount,
  buildDatabaseRunScript,
  pgSslWrapper,
  sslHostDir,
  sslPrepareScript,
  reservedDbEnvKeys,
  buildDbRemoveScript,
  buildDbStopScript,
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
  pgRecoveryTargetTime,
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

    it("walRestore reclaims a replay target's staged-WAL dir only when opted in (byte-identical otherwise)", () => {
      expect(buildDbRemoveScript({ id: "db1" })).not.toContain("wal-restore");
      expect(buildDbRemoveScript({ id: "db1" }, { walRestore: true })).toContain("rm -rf /etc/tugra/wal-restore/db1");
    });
  });

  describe("buildDbStopScript", () => {
    it("is byte-identical to before by default", () => {
      expect(buildDbStopScript({ id: "db1" })).toBe("docker stop tugra_db_db1 2>/dev/null || true");
      expect(buildDbStopScript({ id: "db1" }, {})).toBe("docker stop tugra_db_db1 2>/dev/null || true");
    });
    it("adds a shutdown grace (`-t N`) when asked — the PITR recreate's graceful stop", () => {
      expect(buildDbStopScript({ id: "db1" }, { graceSec: 60 })).toBe("docker stop -t 60 tugra_db_db1 2>/dev/null || true");
      expect(buildDbStopScript({ id: "db1" }, { graceSec: 0 })).toBe("docker stop tugra_db_db1 2>/dev/null || true");
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

  describe("PITR replay (5.6) — recovery run builder", () => {
    const T = new Date("2026-11-13T10:20:30.123Z");

    it("is byte-identical to the plain run when recovery is absent/null", () => {
      const base = buildDatabaseRunScript(spec("POSTGRES"));
      expect(buildDatabaseRunScript(spec("POSTGRES", { recovery: null }))).toBe(base);
      expect(base).not.toContain("wal-restore");
      expect(base).not.toContain("restore_command");
    });

    it("on Postgres: mounts the staged WAL read-only and passes ephemeral -c recovery flags (promote at the target, no archiving)", () => {
      const s = buildDatabaseRunScript(spec("POSTGRES", { recovery: { targetTime: T } }));
      expect(s).toContain("-v /etc/tugra/wal-restore/db1:/tugra-wal-restore:ro");
      expect(s).toContain("-c restore_command='test -f \"/tugra-wal-restore/%f\" && cp \"/tugra-wal-restore/%f\" \"%p\"'");
      expect(s).toContain("-c recovery_target_time='2026-11-13 10:20:30.123+00'"); // UTC with an explicit offset
      expect(s).toContain("-c recovery_target_action=promote");
      expect(s).toContain("-c recovery_target_timeline=current");
      expect(s).toContain("-c archive_mode=off");
      expect(s).not.toContain("archive_mode=on"); // a recovering copy never archives, even if pitr were set
      expect(s).not.toContain("/etc/tugra/wal/db1:"); // no archive spool mount
    });

    it("recovery wins over pitr (mutually exclusive) and is ignored for non-Postgres engines", () => {
      const s = buildDatabaseRunScript(spec("POSTGRES", { recovery: { targetTime: T }, pitr: true }));
      expect(s).toContain("recovery_target_time");
      expect(s).not.toContain("archive_mode=on");
      const my = buildDatabaseRunScript(spec("MYSQL"));
      expect(buildDatabaseRunScript(spec("MYSQL", { recovery: { targetTime: T } }))).toBe(my);
    });

    it("pgRecoveryTargetTime formats a Date as UTC with ms and explicit +00 (never a user string)", () => {
      expect(pgRecoveryTargetTime(T)).toBe("2026-11-13 10:20:30.123+00");
    });
  });
});

describe("database-script: TLS for PostgreSQL (R22)", () => {
  const pg = (extra: Record<string, unknown> = {}) => ({ ...spec("POSTGRES"), ...extra });

  it("ssl off or absent: the run script is byte-identical to before (no wrapper, no mount, no host cert step)", () => {
    const plain = buildDatabaseRunScript(spec("POSTGRES"));
    expect(buildDatabaseRunScript(pg({ ssl: false }))).toBe(plain);
    expect(plain).not.toContain("tugra-ssl");
    expect(plain).not.toContain("openssl");
  });

  it("ssl on: prepares the pair on the host once, mounts it read-only and starts the server through the wrapper", () => {
    const s = buildDatabaseRunScript(pg({ ssl: true }));
    expect(s).toContain("openssl req -new -x509");
    expect(s).toContain(`-v ${sslHostDir("db1")}:/tugra-ssl-src:ro`);
    expect(s).toContain("docker-entrypoint.sh postgres -c ssl=on");
    expect(s).toContain("ssl_cert_file=/var/lib/tugra-ssl/server.crt");
    expect(s).toContain("chown postgres:postgres");
    // the prepare step runs BEFORE the container starts
    expect(s.indexOf("openssl req")).toBeLessThan(s.indexOf("docker run"));
    // the image stays the last quoted word before the wrapper; the wrapper is a single shell word
    expect(s).toMatch(/'postgres:16' sh -c '.*' sh/);
  });

  it("the cert is generated only when missing, the key is 0600 and the dir 0700", () => {
    const p = sslPrepareScript("db1");
    expect(p).toContain(`[ -s ${sslHostDir("db1")}/server.crt ] && [ -s ${sslHostDir("db1")}/server.key ] || openssl`);
    expect(p).toContain("chmod 600");
    expect(p).toContain("chmod 700");
    expect(p).toContain("command -v openssl");
  });

  it("server args (PITR archiving) ride after the wrapper so the entrypoint forwards them to postgres", () => {
    const s = buildDatabaseRunScript(pg({ ssl: true, pitr: true }));
    const wrapperEnd = s.indexOf("' sh ");
    expect(wrapperEnd).toBeGreaterThan(0);
    expect(s.slice(wrapperEnd)).toContain("-c archive_mode=on");
    expect(pgSslWrapper()).toContain('"$@"');
  });

  it("only PostgreSQL gets TLS: any other engine ignores the flag", () => {
    expect(buildDatabaseRunScript({ ...spec("MYSQL"), ssl: true })).toBe(buildDatabaseRunScript(spec("MYSQL")));
    expect(buildDatabaseRunScript({ ...spec("REDIS"), ssl: true })).toBe(buildDatabaseRunScript(spec("REDIS")));
  });

  it("the remove script drops the host pair only when asked (opt-in), and never when the volume is kept", () => {
    expect(buildDbRemoveScript({ id: "db1" })).not.toContain("dbssl");
    expect(buildDbRemoveScript({ id: "db1" }, { ssl: true })).toContain(`rm -rf ${sslHostDir("db1")}`);
    expect(buildDbRemoveScript({ id: "db1" }, { ssl: true, keepVolume: true })).not.toContain("dbssl");
  });
});



describe("database-script: the PostgreSQL data layout (16 / 17 / 18)", () => {
  const mount = (s: string) => /-v tugra_dbv_db1:(\S+)/.exec(s)?.[1];

  it("PostgreSQL 16 and 17 keep the original mount and a byte-identical script (no layout lines)", () => {
    for (const v of ["16", "17"]) {
      const s = buildDatabaseRunScript(spec("POSTGRES", { image: `postgres:${v}`, pgLayout: "data" }));
      expect(mount(s)).toBe("/var/lib/postgresql/data");
      expect(s).not.toContain("PGANON");
      expect(s).toBe(buildDatabaseRunScript(spec("POSTGRES", { image: `postgres:${v}` })));
    }
  });

  it("a new PostgreSQL 18 database mounts the volume at /var/lib/postgresql and leaves PGDATA to the image", () => {
    const s = buildDatabaseRunScript(spec("POSTGRES", { image: "postgres:18", pgLayout: "parent" }));
    expect(mount(s)).toBe("/var/lib/postgresql");
    expect(s).not.toContain("PGDATA");
    expect(s).not.toContain("PGANON");
  });

  it("a PostgreSQL 18 database created before the fix keeps its mount and re-attaches the anonymous volume it already uses", () => {
    const s = buildDatabaseRunScript(spec("POSTGRES", { image: "postgres:18", pgLayout: "legacy-anon" }));
    expect(mount(s)).toBe("/var/lib/postgresql/data");
    expect(s).toContain("PGANON=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination \"/var/lib/postgresql\"}}{{.Name}}{{end}}{{end}}' tugra_db_db1 2>/dev/null || true)");
    expect(s.indexOf("PGANON=$(")).toBeLessThan(s.indexOf("docker rename tugra_db_db1 tugra_db_db1_prev"));
    expect(s).toContain("${PGANON:+-v ${PGANON}:/var/lib/postgresql}");
  });

  it("the other engines ignore a layout", () => {
    for (const e of ["MYSQL", "REDIS", "MONGO"] as DbEngine[]) {
      expect(buildDatabaseRunScript(spec(e, { pgLayout: "parent" }))).toBe(buildDatabaseRunScript(spec(e)));
    }
  });

  it("layout resolution: parent flag wins, an unflagged 18+ row is legacy, 16/17/other engines are plain", () => {
    expect(pgDataLayout({ engine: "POSTGRES", version: "18", image: "postgres:18", pgParentMount: true })).toBe("parent");
    expect(pgDataLayout({ engine: "POSTGRES", version: "18.1", image: "postgres:18", pgParentMount: false })).toBe("legacy-anon");
    expect(pgDataLayout({ engine: "POSTGRES", version: "latest", image: "docker.io/library/postgres:19-alpine" })).toBe("legacy-anon");
    expect(pgDataLayout({ engine: "POSTGRES", version: "17", image: "postgres:17" })).toBe("data");
    expect(pgDataLayout({ engine: "POSTGRES", version: "16.4", image: "postgres:16" })).toBe("data");
    expect(pgDataLayout({ engine: "MYSQL", version: "18", image: "mysql:8", pgParentMount: true })).toBe("data");
    expect(pgMajorOfDb("17-alpine")).toBe(17);
    expect(pgMajorOfDb("", "postgres:18-alpine")).toBe(18);
    expect(pgMajorOfDb("latest", "custom/img:1")).toBeNull();
    expect(pgWantsParentMount("18")).toBe(true);
    expect(pgWantsParentMount("17")).toBe(false);
    expect(dataMountFor("POSTGRES", "parent")).toBe("/var/lib/postgresql");
    expect(dataMountFor("POSTGRES", "legacy-anon")).toBe("/var/lib/postgresql/data");
    expect(dataMountFor("MYSQL", "parent")).toBe("/var/lib/mysql");
  });

  it("the major is read from the image first: a default version 16 does not hide a postgres:18 image", () => {
    expect(pgMajorOfDb("16", "postgres:18")).toBe(18);
    expect(pgMajorOfDb("16", "docker.io/library/postgres:18.1-alpine")).toBe(18);
    expect(pgMajorOfDb("18", "postgres:17")).toBe(17);
    expect(pgMajorOfDb("16", "postgres:18@sha256:" + "a".repeat(64))).toBe(18);
    expect(pgMajorOfDb("16", "registry.example.test:5000/mirror/postgres:18")).toBe(18);
    // floating tags of the official image are the newest major, whatever the stored version says
    for (const image of ["postgres:latest", "postgres:alpine", "postgres", "postgres:bookworm", "postgres:alpine3.22"]) expect(pgMajorOfDb("16", image)).toBe(18);
    expect(pgMajorOfDb("latest", null)).toBe(18);
    expect(pgMajorOfDb("alpine", "")).toBe(18);
    // derived images keep the official layout and say their major in the tag
    expect(pgMajorOfDb("16", "postgis/postgis:18-3.6")).toBe(18);
    expect(pgMajorOfDb("16", "postgis/postgis:17-3.5-alpine")).toBe(17);
    expect(pgMajorOfDb("16", "pgvector/pgvector:pg18")).toBe(18);
    expect(pgMajorOfDb("16", "timescale/timescaledb:2.17.0-pg18")).toBe(18);
    expect(pgMajorOfDb("18", "timescale/timescaledb:2.17.0-pg16")).toBe(16);
    // an image that says nothing leaves the decision to the stored version
    expect(pgMajorOfDb("17", "custom/img:1")).toBe(17);
    expect(pgMajorOfDb("latest", "custom/img:1")).toBeNull();
    expect(pgWantsParentMount("16", "postgres:18")).toBe(true);
    expect(pgWantsParentMount("16", "postgres:latest")).toBe(true);
    expect(pgWantsParentMount("16", "postgis/postgis:18-3.6")).toBe(true);
    expect(pgWantsParentMount("18", "postgres:16")).toBe(false);
    expect(pgDataLayout({ engine: "POSTGRES", version: "16", image: "postgres:18" })).toBe("legacy-anon");
    expect(pgDataLayout({ engine: "POSTGRES", version: "latest", image: "postgres:latest" })).toBe("legacy-anon");
    expect(pgDataLayout({ engine: "POSTGRES", version: "16", image: "postgres:16-alpine" })).toBe("data");
  });

  describe("the legacy-anon scripts under a real shell (a stateful fake docker on PATH)", () => {
    // containers: name -> name of the anonymous volume mounted at /var/lib/postgresql ("" = none). `inspect -f` prints it, `rename`/`rm`/`run` move it.
    const FAKE_DOCKER = [
      "#!/bin/sh",
      'echo "$*" >> "$FAKE/log"',
      'C="$FAKE/c"',
      'case "$1" in',
      '  inspect) shift; f=0; if [ "$1" = -f ]; then f=1; shift 2; fi; n="$1"; [ -e "$C/$n" ] || exit 1; [ "$f" = 1 ] && cat "$C/$n"; exit 0;;',
      '  rename) mv "$C/$2" "$C/$3" || exit 1;;',
      '  rm) shift; n=""; for a in "$@"; do n="$a"; done; rm -f "$C/$n";;',
      '  run) [ -z "$FAKE_RUN_FAIL" ] || exit 125; n=""; p=""; anon=""; for a in "$@"; do [ "$p" = --name ] && n="$a"; case "$a" in *:/var/lib/postgresql) anon="${a%%:*}";; esac; p="$a"; done; printf %s "$anon" > "$C/$n";;',
      "esac",
      "exit 0",
      "",
    ].join("\n");

    function runFake(script: string, containers: Record<string, string>, opts: { runFails?: boolean } = {}) {
      const dir = mkdtempSync(join(tmpdir(), "tugra-pgl-"));
      try {
        mkdirSync(join(dir, "c"));
        for (const [n, anon] of Object.entries(containers)) writeFileSync(join(dir, "c", n), anon);
        writeFileSync(join(dir, "docker"), FAKE_DOCKER);
        chmodSync(join(dir, "docker"), 0o755);
        writeFileSync(join(dir, "run.sh"), script);
        const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, FAKE: dir, FAKE_RUN_FAIL: opts.runFails ? "1" : "" };
        const r = spawnSync("sh", [join(dir, "run.sh")], { env, encoding: "utf8" });
        const log = readFileSync(join(dir, "log"), "utf8").split("\n").filter(Boolean);
        const after: Record<string, string> = {};
        for (const n of readdirSync(join(dir, "c"))) after[n] = readFileSync(join(dir, "c", n), "utf8");
        return { status: r.status, log, after, runLine: log.find((l) => l.startsWith("run -d")) };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    const legacyRun = () => buildDatabaseRunScript(spec("POSTGRES", { image: "postgres:18", pgLayout: "legacy-anon" }));
    const NAME = "tugra_db_db1";
    const ANON = "0123456789abcdef".repeat(4);

    it("passes the anonymous volume as its own -v argument when the old container has one, and drops the old container only afterwards", () => {
      const r = runFake(legacyRun(), { [NAME]: ANON });
      expect(r.status).toBe(0);
      expect(r.runLine).toContain(`-v tugra_dbv_db1:/var/lib/postgresql/data -v ${ANON}:/var/lib/postgresql `);
      expect(r.after).toEqual({ [NAME]: ANON }); // the new container holds the volume, nothing is left under the aside name
      expect(r.log.findIndex((l) => l.startsWith("run -d"))).toBeLessThan(r.log.indexOf(`rm -f ${NAME}_prev`, r.log.findIndex((l) => l.startsWith("run -d"))));
    });

    it("adds nothing when there is no old container (first start)", () => {
      const r = runFake(legacyRun(), {});
      expect(r.status).toBe(0);
      expect(r.runLine).toContain("-v tugra_dbv_db1:/var/lib/postgresql/data ");
      expect(r.runLine).not.toMatch(/-v \S+:\/var\/lib\/postgresql /);
    });

    it("a failed start puts the old container back instead of leaving its anonymous volume dangling", () => {
      const r = runFake(legacyRun(), { [NAME]: ANON }, { runFails: true });
      expect(r.status).toBe(125);
      expect(r.after).toEqual({ [NAME]: ANON }); // the old container is back under its name, still holding the volume
      expect(r.log).toContain(`start ${NAME}`);
    });

    it("an earlier recreate that died between the rename and the run is picked up: the aside container is the one re-attached", () => {
      const r = runFake(legacyRun(), { [`${NAME}_prev`]: ANON });
      expect(r.status).toBe(0);
      expect(r.runLine).toContain(`-v ${ANON}:/var/lib/postgresql `);
      expect(r.after).toEqual({ [NAME]: ANON });
    });

    it("another layout keeps the plain remove-then-run sequence (no aside name)", () => {
      for (const pgLayout of ["data", "parent"] as const) {
        expect(buildDatabaseRunScript(spec("POSTGRES", { image: "postgres:18", pgLayout }))).not.toContain("_prev");
      }
    });

    const rmScript = (opts: Parameters<typeof buildDbRemoveScript>[1]) => buildDbRemoveScript({ id: "db1" }, opts);

    it("deleting a legacy-anon database removes its anonymous volume with the data volume", () => {
      const r = runFake(rmScript({ legacyAnon: true }), { [NAME]: ANON });
      expect(r.status).toBe(0);
      expect(r.log).toContain(`volume rm ${ANON}`);
      expect(r.log).toContain("volume rm tugra_dbv_db1");
      expect(r.log.findIndex((l) => l === `rm -f ${NAME}`)).toBeLessThan(r.log.indexOf(`volume rm ${ANON}`));
    });

    it("never removes a volume somebody named, keeps it with keepVolume, and is a no-op for other layouts", () => {
      expect(runFake(rmScript({ legacyAnon: true }), { [NAME]: "my-own-volume" }).log.join("\n")).not.toContain("volume rm my-own-volume");
      expect(runFake(rmScript({ legacyAnon: true }), { [NAME]: "" }).log.filter((l) => l.startsWith("volume rm "))).toEqual(["volume rm tugra_dbv_db1"]);
      expect(runFake(rmScript({ legacyAnon: true, keepVolume: true }), { [NAME]: ANON }).log).not.toContain(`volume rm ${ANON}`);
      expect(rmScript({})).not.toContain("PGANON");
      expect(rmScript({})).toBe(buildDbRemoveScript({ id: "db1" }));
    });
  });
});
