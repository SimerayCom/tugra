/**
 * Heuristic "is this app a database / message broker / object store?" used to put a speed bump in front of
 * volume WRITES while it is running (editing a live postgres data dir corrupts it). Pure, deliberately BEST-EFFORT
 * (an image we do not know is simply not flagged) with an explicit `acknowledgeRisk` override — never a hard block.
 *
 * An image matches when its repo path is `[owner/]name` where the NAME is a datastore token (optionally followed by
 * one allow-listed variant suffix) and the OWNER is empty, `library`, a publisher on the allow-list, or the token
 * itself (`valkey/valkey`, `clickhouse/clickhouse-server`). `myorg/redis`, `redis-exporter` and `app/postgresql-ui`
 * stay unflagged on purpose.
 */
const DATASTORES = [
  "postgres", "postgresql", "postgis", "pgvector", "pgvecto-rs", "timescaledb", "mysql", "mariadb", "percona", "percona-server",
  "percona-server-mongodb", "percona-distribution-postgresql", "mongo", "mongodb", "mongodb-community-server",
  "mongodb-enterprise-server", "redis", "redis-stack", "valkey", "keydb", "dragonfly", "clickhouse", "cassandra",
  "scylla", "influxdb", "couchdb", "couchbase", "etcd", "memcached", "rabbitmq", "kafka", "cp-kafka", "zookeeper",
  "cp-zookeeper", "minio", "elasticsearch", "opensearch", "cockroach", "cockroachdb", "neo4j", "mssql", "surrealdb",
  "questdb", "qdrant", "arangodb",
];
/** Publishers whose repos are (mostly) datastores. The datastore token itself is always an acceptable owner. */
const OWNERS = new Set([
  "", "library", "bitnami", "bitnamilegacy", "timescale", "pgvector", "supabase", "percona", "apache", "confluentinc", "mongodb",
  "cockroachdb", "opensearchproject", "elasticsearch", "redis", "valkey", "postgis", "influxdata", "mysql", "mariadb", "minio",
  "scylladb", "neo4j", "couchbase", "bitnamisecure", "mssql", "arangodb",
]);
/** Variant suffixes of a datastore image (`-server`, `-ha`, `-alpine`), never `-exporter` / `-ui` / `-client`. */
const SUFFIX = "(?:-(?:server|community-server|enterprise-server|ha|repmgr|cluster|sentinel|sharded|alpine|bookworm|stack|stack-server))?";
const NAME_RE = new RegExp(`^(${DATASTORES.join("|")})${SUFFIX}$`);

/** The repo part of an image reference: lowercased, registry host / tag / digest stripped. */
function repoOf(ref: string): string {
  let r = ref.trim().replace(/^["']|["']$/g, "").toLowerCase().split("@")[0];
  const segs = r.split("/");
  if (segs.length > 1 && (/[.:]/.test(segs[0]) || segs[0] === "localhost")) segs.shift(); // registry host
  r = segs.join("/");
  return r.replace(/:[^/]*$/, ""); // tag
}

/** True when an image reference (or template slug) names a known datastore (best-effort; see the file header). */
export function isDatastoreRef(ref: string | null | undefined): boolean {
  if (!ref) return false;
  const segs = repoOf(ref).split("/");
  if (segs.length > 2) return false;
  const name = segs[segs.length - 1];
  const owner = segs.length === 2 ? segs[0] : "";
  const m = NAME_RE.exec(name);
  if (!m) return false;
  return OWNERS.has(owner) || owner === m[1] || (owner !== "" && NAME_RE.test(owner) && name.startsWith(owner));
}

/** Every `image:` value in a compose file (line regex; no YAML parse needed for a heuristic). */
function composeImages(composeFile: string | null | undefined): string[] {
  if (!composeFile) return [];
  const out: string[] = [];
  for (const line of composeFile.split("\n")) {
    const m = /^\s*image:\s*(\S+)/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

export interface DatastoreProbe {
  source?: string | null;
  image?: string | null;
  composeFile?: string | null;
  templateSlug?: string | null;
}

/** Does any of the app's image, compose service images or template slug look like a datastore? */
export function looksLikeDatastore(app: DatastoreProbe): boolean {
  if (isDatastoreRef(app.templateSlug)) return true;
  if (app.source === "COMPOSE") return composeImages(app.composeFile).some(isDatastoreRef);
  return isDatastoreRef(app.image);
}
