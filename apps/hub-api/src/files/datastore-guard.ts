/**
 * Heuristic "is this app a database / message broker / object store?" used to put a speed bump in front of
 * volume WRITES while it is running (editing a live postgres data dir corrupts it). Pure, deliberately a
 * heuristic with an explicit `acknowledgeRisk` override — never a hard block.
 */
const DATASTORES = [
  "postgres", "postgis", "mysql", "mariadb", "mongo", "redis", "valkey", "clickhouse", "cassandra", "influxdb",
  "couchdb", "etcd", "memcached", "rabbitmq", "kafka", "minio", "elasticsearch", "opensearch",
];
const NAME = new RegExp(`^(?:library/|bitnami/)?(${DATASTORES.join("|")})(?:/[a-z0-9._-]+)?$`);

/** The repo part of an image reference: lowercased, registry host / tag / digest stripped. */
function repoOf(ref: string): string {
  let r = ref.trim().replace(/^["']|["']$/g, "").toLowerCase().split("@")[0];
  const segs = r.split("/");
  if (segs.length > 1 && (/[.:]/.test(segs[0]) || segs[0] === "localhost")) segs.shift(); // registry host
  r = segs.join("/");
  return r.replace(/:[^/]*$/, ""); // tag
}

/** True when an image reference (or template slug) names a known datastore. `name/name-xyz` also matches
 *  (postgis/postgis, clickhouse/clickhouse-server, valkey/valkey). */
export function isDatastoreRef(ref: string | null | undefined): boolean {
  if (!ref) return false;
  const repo = repoOf(ref);
  const m = NAME.exec(repo);
  if (!m) return false;
  const rest = repo.slice(repo.indexOf(m[1]) + m[1].length);
  return rest === "" || rest.startsWith(`/${m[1]}`);
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
