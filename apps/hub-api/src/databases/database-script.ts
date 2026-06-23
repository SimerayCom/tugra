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
  | "CLICKHOUSE";

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
};

/** Whether a dump/restore backup pipeline exists for this engine (Dilim 17). */
export function supportsBackup(engine: DbEngine): boolean {
  return engine !== "DRAGONFLY" && engine !== "CLICKHOUSE";
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

/** Connection details for apps on the same docker network (host = container name). */
export function connectionInfo(db: DbSpec): ConnectionInfo {
  const { scheme } = ENGINES[db.engine];
  const host = dbContainerName(db);
  const { username, password, database } = db.credentials;
  const auth = username ? `${username}:${password}@` : `:${password}@`;
  const redisFamily = db.engine === "REDIS" || db.engine === "KEYDB" || db.engine === "DRAGONFLY";
  let uri: string;
  if (redisFamily) {
    uri = `${scheme}://:${password}@${host}:${db.port}`;
  } else if (db.engine === "MONGO") {
    uri = `${scheme}://${auth}${host}:${db.port}`;
  } else {
    uri = `${scheme}://${auth}${host}:${db.port}/${database}`;
  }
  return { internalHost: host, port: db.port, username, password, database, uri };
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
