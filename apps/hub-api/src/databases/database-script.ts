/**
 * Pure builders for the shell scripts the agent runs to provision a managed
 * database container with a persistent named volume. Each engine has its own
 * image, port, data dir and credential-passing convention (env vars, except
 * Redis which takes a `--requirepass` command argument).
 */

export const DB_NET = "tugra-net";

export type DbEngine =
  | "POSTGRES"
  | "MYSQL"
  | "REDIS"
  | "MONGO"
  | "MARIADB"
  | "KEYDB"
  | "DRAGONFLY"
  | "CLICKHOUSE"
  | "LIBSQL";

export interface EngineDef {
  imagePrefix: string; // e.g. "postgres" → image = "postgres:<version>"
  alpineSuffix?: boolean; // redis uses "<version>-alpine"
  port: number;
  dataDir: string;
  scheme: string; // connection URI scheme
  defaultVersion: string;
}

export const ENGINES: Record<DbEngine, EngineDef> = {
  POSTGRES: { imagePrefix: "postgres", port: 5432, dataDir: "/var/lib/postgresql/data", scheme: "postgresql", defaultVersion: "16" },
  MYSQL: { imagePrefix: "mysql", port: 3306, dataDir: "/var/lib/mysql", scheme: "mysql", defaultVersion: "8" },
  REDIS: { imagePrefix: "redis", alpineSuffix: true, port: 6379, dataDir: "/data", scheme: "redis", defaultVersion: "7" },
  MONGO: { imagePrefix: "mongo", port: 27017, dataDir: "/data/db", scheme: "mongodb", defaultVersion: "7" },
  MARIADB: { imagePrefix: "mariadb", port: 3306, dataDir: "/var/lib/mysql", scheme: "mysql", defaultVersion: "11" },
  KEYDB: { imagePrefix: "eqalpha/keydb", port: 6379, dataDir: "/data", scheme: "redis", defaultVersion: "latest" },
  DRAGONFLY: { imagePrefix: "docker.dragonflydb.io/dragonflydb/dragonfly", port: 6379, dataDir: "/data", scheme: "redis", defaultVersion: "latest" },
  CLICKHOUSE: { imagePrefix: "clickhouse/clickhouse-server", port: 9000, dataDir: "/var/lib/clickhouse", scheme: "clickhouse", defaultVersion: "24" },
  // libSQL server (sqld) — SQLite over HTTP/Hrana. No username/password model (optional JWT auth, a
  // follow-up); v1 runs on the internal tugra-net with no built-in auth, reachable by co-located apps.
  LIBSQL: { imagePrefix: "ghcr.io/tursodatabase/libsql-server", port: 8080, dataDir: "/var/lib/sqld", scheme: "http", defaultVersion: "latest" },
};

/** Whether a dump/restore backup pipeline exists for this engine — all 8 engines are supported
 *  (Postgres/MySQL/MariaDB/Mongo/Redis/KeyDB + Dragonfly `SAVE RDB`/`DFLY LOAD` + ClickHouse
 *  `BACKUP … TO File`/`RESTORE`). Kept as a function so a future unsupported engine can opt out. */
export function supportsBackup(engine: DbEngine): boolean {
  // libSQL has no dump/restore pipeline (its data is a single SQLite file captured by volume backups).
  return engine !== "LIBSQL";
}

export interface DbCredentials {
  username: string;
  password: string;
  database: string;
}

export interface DbSpec {
  id: string;
  engine: DbEngine;
  image: string;
  port: number;
  hostPort?: number | null;
  credentials: DbCredentials;
  healthCmd?: string | null;
  memoryMb?: number | null;
  cpus?: number | null;
}

export function dbContainerName(db: { id: string }): string {
  return `tugra_db_${db.id}`;
}

export function dbVolumeName(db: { id: string }): string {
  return `tugra_dbv_${db.id}`;
}

function shq(v: string): string {
  return `'${v.replaceAll("'", "'\\''")}'`;
}

export function resolveImage(engine: DbEngine, version?: string | null): string {
  const def = ENGINES[engine];
  const ver = version || def.defaultVersion;
  return def.alpineSuffix ? `${def.imagePrefix}:${ver}-alpine` : `${def.imagePrefix}:${ver}`;
}

export function enginePort(engine: DbEngine): number {
  return ENGINES[engine].port;
}

/** Env vars the engine reads to bootstrap credentials (Redis uses a command instead). */
export function credentialEnv(engine: DbEngine, creds: DbCredentials): Record<string, string> {
  switch (engine) {
    case "POSTGRES":
      return { POSTGRES_USER: creds.username, POSTGRES_PASSWORD: creds.password, POSTGRES_DB: creds.database };
    case "MYSQL":
      return {
        MYSQL_ROOT_PASSWORD: creds.password,
        MYSQL_DATABASE: creds.database,
        MYSQL_USER: creds.username,
        MYSQL_PASSWORD: creds.password,
      };
    case "MARIADB":
      return {
        MARIADB_ROOT_PASSWORD: creds.password,
        MARIADB_DATABASE: creds.database,
        MARIADB_USER: creds.username,
        MARIADB_PASSWORD: creds.password,
      };
    case "MONGO":
      return { MONGO_INITDB_ROOT_USERNAME: creds.username, MONGO_INITDB_ROOT_PASSWORD: creds.password };
    case "CLICKHOUSE":
      return { CLICKHOUSE_USER: creds.username, CLICKHOUSE_PASSWORD: creds.password, CLICKHOUSE_DB: creds.database };
    case "REDIS":
    case "KEYDB":
    case "DRAGONFLY":
      return {};
    case "LIBSQL":
      // sqld runs with its defaults (HTTP listener on 8080, data at dataDir); no credential env.
      return {};
  }
}

/** Redis-family engines carry their password as a server arg; others return "". */
export function engineCommand(engine: DbEngine, creds: DbCredentials): string {
  switch (engine) {
    case "REDIS":
      return `redis-server --requirepass ${shq(creds.password)}`;
    case "KEYDB":
      return `keydb-server --requirepass ${shq(creds.password)}`;
    case "DRAGONFLY":
      return `--requirepass ${shq(creds.password)}`; // image entrypoint is `dragonfly`
    default:
      return "";
  }
}

export interface ConnectionInfo {
  internalHost: string;
  port: number;
  username: string;
  password: string;
  database: string;
  uri: string;
}

/**
 * Build an engine-specific connection URI for a given host:port.
 * URL-encode credentials so an imported password containing `@ : / # %` etc. yields a valid
 * connection string (generated base64url creds are URL-safe, so this is a no-op for DBs created
 * by Tugra). IPv6 literals in `host` are bracketed; container names (the internal host) never
 * contain `:`, so that is a no-op for the internal URI.
 */
function buildUri(engine: DbEngine, host: string, port: number, creds: DbCredentials): string {
  const { scheme } = ENGINES[engine];
  const { username, password, database } = creds;
  const e = encodeURIComponent;
  const h = host.includes(":") ? `[${host}]` : host;
  const auth = username ? `${e(username)}:${e(password)}@` : `:${e(password)}@`;
  const redisFamily = engine === "REDIS" || engine === "KEYDB" || engine === "DRAGONFLY";
  if (engine === "LIBSQL") {
    // sqld speaks HTTP with no built-in auth in v1 — a plain host:port URL, no credentials.
    return `${scheme}://${h}:${port}`;
  }
  if (redisFamily) return `${scheme}://:${e(password)}@${h}:${port}`;
  if (engine === "MONGO") return `${scheme}://${auth}${h}:${port}`;
  return `${scheme}://${auth}${h}:${port}/${e(database)}`;
}

/** Connection details for apps on the same docker network (host = container name). */
export function connectionInfo(db: DbSpec): ConnectionInfo {
  const host = dbContainerName(db);
  const { username, password, database } = db.credentials;
  // The returned username/password/database fields stay RAW — only the `uri` is encoded.
  return { internalHost: host, port: db.port, username, password, database, uri: buildUri(db.engine, host, db.port, db.credentials) };
}

/**
 * Connection URI for reaching this DB from OUTSIDE Tugra's network — valid only when a public host
 * port is mapped (`hostPort`) and the server's public address is known. host = server public IP,
 * port = the mapped host port.
 */
export function publicConnectionUri(db: DbSpec, publicHost: string, hostPort: number): string {
  return buildUri(db.engine, publicHost, hostPort, db.credentials);
}

export function buildDatabaseRunScript(db: DbSpec): string {
  const name = dbContainerName(db);
  const vol = dbVolumeName(db);
  const def = ENGINES[db.engine];
  const envFlags = Object.entries(credentialEnv(db.engine, db.credentials))
    .map(([k, v]) => `-e ${shq(`${k}=${v}`)}`)
    .join(" ");
  const portFlag = db.hostPort ? `-p ${db.hostPort}:${db.port}` : "";
  const command = engineCommand(db.engine, db.credentials);

  // Optional resource limits + container health check (mirrors app deploys).
  const limitArgs: string[] = [];
  if (db.memoryMb) limitArgs.push(`--memory ${db.memoryMb}m`);
  if (db.cpus) limitArgs.push(`--cpus ${db.cpus}`);
  if (db.healthCmd) {
    limitArgs.push(
      `--health-cmd ${shq(db.healthCmd)}`,
      "--health-interval=30s",
      "--health-timeout=5s",
      "--health-retries=3",
      "--health-start-period=10s",
    );
  }

  const runArgs = [
    "docker run -d",
    `--name ${name}`,
    "--restart unless-stopped",
    `--network ${DB_NET}`,
    `-v ${vol}:${def.dataDir}`,
    limitArgs.join(" "),
    envFlags,
    portFlag,
    shq(db.image),
    command,
  ]
    .filter(Boolean)
    .join(" ");

  return [
    "set -e",
    `docker network create ${DB_NET} 2>/dev/null || true`,
    `docker pull ${shq(db.image)}`,
    `docker rm -f ${name} 2>/dev/null || true`,
    runArgs,
    `docker ps --filter name=${name} --format '{{.Status}}'`,
  ].join("\n");
}

export function buildDbStopScript(db: { id: string }): string {
  return `docker stop ${dbContainerName(db)} 2>/dev/null || true`;
}

/** Destroy: remove the container AND its volume (the data is intentionally dropped). */
export function buildDbRemoveScript(db: { id: string }): string {
  return [
    `docker rm -f ${dbContainerName(db)} 2>/dev/null || true`,
    `docker volume rm ${dbVolumeName(db)} 2>/dev/null || true`,
  ].join("\n");
}
