/**
 * Pure builders for the shell scripts the agent runs to provision a managed
 * database container with a persistent named volume. Each engine has its own
 * image, port, data dir and credential-passing convention (env vars, except
 * Redis which takes a `--requirepass` command argument).
 */

export const DB_NET = "tugra-net";

// PITR WAL archive layout. Each completed WAL segment is copied by Postgres's archive_command into a per-DB
// host spool under /etc/tugra/wal/<id> (a bind mount — the agent has /etc/tugra at the host path, so the 5.5
// shipper reads/drains it directly). Deliberately NOT under /etc/tugra/backups, so the LOCAL-backup list/prune
// never sees WAL files. The dir is mounted into the container at WAL_CONTAINER_DIR.
export const WAL_HOST_ROOT = "/etc/tugra/wal";
export const WAL_CONTAINER_DIR = "/tugra-wal";
// How long an idle Postgres waits before force-switching to a new WAL segment (so PITR has a bounded recovery
// granularity even with little write activity).
const ARCHIVE_TIMEOUT_SEC = 300;

/** The per-database host spool dir (bind-mounted into the container). Keyed on the row id, never user input. */
export function walHostDir(dbId: string): string {
  return `${WAL_HOST_ROOT}/${dbId}`;
}

/**
 * The archive_command Postgres runs (inside its own container, via /bin/sh) for each completed WAL segment.
 * %p = the segment's path (relative to the data dir), %f = its filename — both expanded by Postgres, not the
 * shell here. Idempotent (an already-archived segment is a success, so a retry after a crash never loops),
 * atomic (copy to a .part then rename, so the shipper never reads a half-written segment) and DURABLE: the
 * .part is fsync'd before the rename. Postgres treats exit 0 as "this segment is safely archived" and may
 * recycle it from pg_wal at the next checkpoint, so the host spool is then the ONLY copy — without the sync a
 * power loss inside the writeback window could leave a truncated segment that the `[ -f ]` guard would treat as
 * archived forever, silently breaking the WAL chain. `sync <file>` fsyncs just that file on GNU coreutils (the
 * stock postgres image) and falls back to a global flush on busybox — correct either way.
 */
export function pgArchiveCommand(): string {
  const dest = `${WAL_CONTAINER_DIR}/%f`;
  return `[ -f "${dest}" ] && exit 0; cp %p "${dest}.part" && sync "${dest}.part" && mv "${dest}.part" "${dest}"`;
}

/** Postgres server args that enable WAL archiving. Placed in the engine-command slot (after the image) when a
 *  DB has PITR on. wal_level is deliberately NOT forced (replica is the stock default; forcing it could
 *  downgrade a logical setup) — an off-default wal_level is caught by the enable-path preflight (slice 5.4b). */
export function pgArchiveArgs(): string {
  return `-c archive_mode=on -c archive_timeout=${ARCHIVE_TIMEOUT_SEC} -c archive_command=${shq(pgArchiveCommand())}`;
}

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
  // User-set container env, injected BEFORE credentialEnv so it can never shadow the managed credentials.
  env?: Record<string, string> | null;
  // Extra persistent named volumes (beyond the managed data volume). Name is a short label; the real docker
  // volume name is derived per-database so it can never collide with another DB's (or infra) volumes.
  volumes?: DbVolume[] | null;
  // PITR: when true (Postgres only) the container is (re)created with WAL ARCHIVING on — archive_mode=on + an
  // archive_command that copies each completed WAL segment to a host spool the shipper drains. Default/false →
  // the run script is byte-identical to a non-PITR database. Set only from the real-DB path (never throwaways).
  pitr?: boolean;
}

export interface DbVolume {
  name: string;
  path: string;
}

export function dbContainerName(db: { id: string }): string {
  return `tugra_db_${db.id}`;
}

export function dbVolumeName(db: { id: string }): string {
  return `tugra_dbv_${db.id}`;
}

/** Docker volume name for a database's EXTRA named volume — derived per-database so a tenant label can
 *  never name another database's (or an infra) volume. */
export function dbExtraVolumeName(db: { id: string }, name: string): string {
  return `tugra_dbv_${db.id}_${name}`;
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

// Beyond the exact credential vars that credentialEnv() emits, each official image reads further env vars
// that DISABLE, RANDOMIZE, or re-source the managed credentials (so a stored password would no longer
// protect the DB, or the entrypoint would crash-loop). Users may not set these — rejected up front so the
// Tugra-managed credential always protects the database. Redis-family/libSQL carry auth via server args,
// not env, so they have nothing extra to block.
const AUTH_OVERRIDE_ENV: Record<DbEngine, readonly string[]> = {
  POSTGRES: ["POSTGRES_HOST_AUTH_METHOD", "POSTGRES_PASSWORD_FILE", "POSTGRES_USER_FILE", "POSTGRES_DB_FILE"],
  MYSQL: [
    "MYSQL_ALLOW_EMPTY_PASSWORD", "MYSQL_RANDOM_ROOT_PASSWORD", "MYSQL_ONETIME_PASSWORD", "MYSQL_ROOT_HOST",
    "MYSQL_ROOT_PASSWORD_FILE", "MYSQL_PASSWORD_FILE", "MYSQL_USER_FILE", "MYSQL_DATABASE_FILE",
  ],
  MARIADB: [
    // MariaDB's entrypoint honours both the MARIADB_* and the legacy MYSQL_* names.
    "MARIADB_ALLOW_EMPTY_ROOT_PASSWORD", "MARIADB_RANDOM_ROOT_PASSWORD", "MARIADB_ROOT_HOST",
    "MARIADB_ROOT_PASSWORD_FILE", "MARIADB_PASSWORD_FILE", "MARIADB_USER_FILE", "MARIADB_DATABASE_FILE",
    "MYSQL_ALLOW_EMPTY_PASSWORD", "MYSQL_RANDOM_ROOT_PASSWORD", "MYSQL_ROOT_HOST",
    "MYSQL_ROOT_PASSWORD_FILE", "MYSQL_PASSWORD_FILE", "MYSQL_USER_FILE", "MYSQL_DATABASE_FILE",
  ],
  MONGO: ["MONGO_INITDB_ROOT_USERNAME_FILE", "MONGO_INITDB_ROOT_PASSWORD_FILE"],
  CLICKHOUSE: ["CLICKHOUSE_SKIP_USER_SETUP", "CLICKHOUSE_USER_FILE", "CLICKHOUSE_PASSWORD_FILE", "CLICKHOUSE_PASSWORD_SHA256_HEX"],
  REDIS: [],
  KEYDB: [],
  DRAGONFLY: [],
  LIBSQL: [],
};

/**
 * Env var names a user may NOT set on a database: the engine's own credential vars (credentialEnv) plus the
 * image's auth-override vars. Enforced in DatabasesService.setEnv so a stored credential always protects the DB.
 */
export function reservedDbEnvKeys(engine: DbEngine): Set<string> {
  const creds = Object.keys(credentialEnv(engine, { username: "", password: "", database: "" }));
  return new Set([...creds, ...AUTH_OVERRIDE_ENV[engine]]);
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
  // User env FIRST, then credential env: later `-e` flags win in docker, so the managed credentials always
  // override a user var of the same name (defence-in-depth alongside the reserved-key reject in the service).
  const toEnvFlags = (env: Record<string, string>) =>
    Object.entries(env).map(([k, v]) => `-e ${shq(`${k}=${v}`)}`).join(" ");
  const userEnvFlags = db.env ? toEnvFlags(db.env) : "";
  const credEnvFlags = toEnvFlags(credentialEnv(db.engine, db.credentials));
  const portFlag = db.hostPort ? `-p ${db.hostPort}:${db.port}` : "";
  // Extra persistent volumes (name + path both charset-validated upstream: no ':' in path, derived volume
  // name, so the `-v name:path` grammar can't be broken).
  const extraVolFlags = (db.volumes ?? [])
    .map((v) => `-v ${dbExtraVolumeName(db, v.name)}:${v.path}`)
    .join(" ");
  // PITR (Postgres only): mount the host WAL spool and append the archive_mode args to the engine command.
  // When off, walFlag is "" (filtered) and command is unchanged → the script is byte-identical to today.
  const pitr = db.engine === "POSTGRES" && !!db.pitr;
  const walFlag = pitr ? `-v ${walHostDir(db.id)}:${WAL_CONTAINER_DIR}` : "";
  const baseCommand = engineCommand(db.engine, db.credentials);
  const command = pitr ? [baseCommand, pgArchiveArgs()].filter(Boolean).join(" ") : baseCommand;

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
    // Cap json-file logs so a chatty DB can't fill the host disk (~30MB/container); matches LOG_ROTATION_ARGS
    // in deploy-script.ts (kept inline here to keep this builder dependency-free).
    "--log-driver json-file --log-opt max-size=10m --log-opt max-file=3",
    `--network ${DB_NET}`,
    `-v ${vol}:${def.dataDir}`,
    extraVolFlags,
    walFlag,
    limitArgs.join(" "),
    userEnvFlags,
    credEnvFlags,
    portFlag,
    shq(db.image),
    command,
  ]
    .filter(Boolean)
    .join(" ");

  return [
    "set -e",
    `docker network create ${DB_NET} 2>/dev/null || true`,
    // PITR: create the host WAL spool before the mount so the first archive attempt never fails on a missing
    // dir; tightened to 0700 (it holds raw WAL). postgres in the container runs as uid 999 and can't write
    // into a root-owned bind, so after the container is up we chown the mount to its runtime uid. Both lines
    // are emitted only when pitr is on, so the off-path script is byte-identical to today.
    ...(pitr ? [`mkdir -p ${walHostDir(db.id)} && chmod 700 ${walHostDir(db.id)}`] : []),
    `docker pull ${shq(db.image)}`,
    `docker rm -f ${name} 2>/dev/null || true`,
    runArgs,
    ...(pitr ? [`docker exec -u root ${name} chown postgres:postgres ${WAL_CONTAINER_DIR}`] : []),
    `docker ps --filter name=${name} --format '{{.Status}}'`,
  ].join("\n");
}

export function buildDbStopScript(db: { id: string }): string {
  return `docker stop ${dbContainerName(db)} 2>/dev/null || true`;
}

/** Destroy: remove the container AND its volumes (the data is intentionally dropped). */
export function buildDbRemoveScript(
  db: { id: string; volumes?: DbVolume[] | null },
  opts: { keepVolume?: boolean; walSpool?: boolean } = {},
): string {
  const lines = [`docker rm -f ${dbContainerName(db)} 2>/dev/null || true`];
  // keepVolume: leave the data volume on the host (recreate the DB over it later, or copy it off). Default
  // removes it — a deleted database frees its disk, as before. Extra named volumes are dropped the same way
  // so a deleted database never orphans them.
  if (!opts.keepVolume) {
    lines.push(`docker volume rm ${dbVolumeName(db)} 2>/dev/null || true`);
    for (const v of db.volumes ?? []) lines.push(`docker volume rm ${dbExtraVolumeName(db, v.name)} 2>/dev/null || true`);
  }
  // walSpool: this DB had PITR on, so its host WAL spool must be reclaimed too (idempotent; the dir holds raw
  // WAL, not the data dir). Only emitted when the caller opts in — every current caller omits it, so the
  // script stays byte-identical until the PITR enable path (next slice) starts passing it on destroy.
  if (opts.walSpool && !opts.keepVolume) lines.push(`rm -rf ${walHostDir(db.id)} 2>/dev/null || true`);
  return lines.join("\n");
}
