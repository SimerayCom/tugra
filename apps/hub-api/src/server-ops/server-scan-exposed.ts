import { z } from "zod";
import { imageSegments, softwareForImage } from "./server-scan-software";

/**
 * "Exposed services": a computed, READ-ONLY verdict over the scan's listening ports. A public port (listening on every
 * interface) whose owner is a database, cache, queue, search engine, object store, admin UI or the Docker API is a
 * finding; nothing is ever closed automatically. The owner comes from, in order: the container that publishes the port
 * (its image says what it is), then the port number itself for the unambiguous well-known ones (a host service such as a
 * systemd mysqld has no container). Everything is derived from already-validated scan data; no free text from the host
 * reaches the finding except the container name (already charset-validated by the docker probe parser).
 */

export const EXPOSED_KINDS = ["database", "cache", "queue", "search", "storage", "admin", "docker"] as const;
export type ExposedKind = (typeof EXPOSED_KINDS)[number];
export const EXPOSED_SEVERITIES = ["critical", "high", "medium"] as const;
export type ExposedSeverity = (typeof EXPOSED_SEVERITIES)[number];
/** What to do about it (the web renders the plain-language hint from this code; the firewall hint is always shown). */
export const EXPOSED_FIXES = ["publish_local", "bind_local", "docker_api"] as const;
export type ExposedFix = (typeof EXPOSED_FIXES)[number];

export const ExposedServiceSchema = z.object({
  port: z.number().int().min(1).max(65535),
  /** Display name of what listens ("PostgreSQL", "Redis", "phpMyAdmin", ...). */
  service: z.string().max(80),
  kind: z.enum(EXPOSED_KINDS),
  severity: z.enum(EXPOSED_SEVERITIES),
  /** The container publishing the port, or null when a host process / unknown owner holds it. */
  container: z.string().max(128).nullable(),
  /** "container": the image identified it; "account": the (non-root) account owning the socket is a data store's
   *  (mysql, redis...); "port": only the well-known port number did (confirm before acting). */
  basis: z.enum(["container", "account", "port"]),
  fix: z.enum(EXPOSED_FIXES),
});
export type ExposedService = z.infer<typeof ExposedServiceSchema>;

interface Def {
  service: string;
  kind: ExposedKind;
  severity: ExposedSeverity;
}
const d = (service: string, kind: ExposedKind, severity: ExposedSeverity): Def => ({ service, kind, severity });

/** Scan software-registry id → exposure class (only stores that should not face the internet). */
const BY_SOFTWARE: Record<string, Def> = {
  postgres: d("PostgreSQL", "database", "high"),
  mysql: d("MySQL", "database", "high"),
  mariadb: d("MariaDB", "database", "high"),
  mongo: d("MongoDB", "database", "critical"),
  clickhouse: d("ClickHouse", "database", "high"),
  redis: d("Redis", "cache", "critical"),
  valkey: d("Valkey", "cache", "critical"),
  keydb: d("KeyDB", "cache", "critical"),
  dragonfly: d("Dragonfly", "cache", "critical"),
  memcached: d("Memcached", "cache", "critical"),
  elasticsearch: d("Elasticsearch", "search", "critical"),
  meilisearch: d("Meilisearch", "search", "medium"),
  typesense: d("Typesense", "search", "medium"),
  qdrant: d("Qdrant", "search", "high"),
  rabbitmq: d("RabbitMQ", "queue", "high"),
  minio: d("MinIO", "storage", "medium"),
};

/** Admin UIs, keyed by the image's last path segment (`dpage/pgadmin4` → `pgadmin4`). */
const ADMIN_IMAGES: Record<string, Def> = {
  phpmyadmin: d("phpMyAdmin", "admin", "high"),
  adminer: d("Adminer", "admin", "high"),
  pgadmin4: d("pgAdmin", "admin", "high"),
  pgadmin: d("pgAdmin", "admin", "high"),
  "mongo-express": d("Mongo Express", "admin", "high"),
  "redis-commander": d("Redis Commander", "admin", "high"),
  redisinsight: d("RedisInsight", "admin", "high"),
  portainer: d("Portainer", "admin", "high"),
  "portainer-ce": d("Portainer", "admin", "high"),
  kibana: d("Kibana", "admin", "medium"),
};

/** Well-known listening ports with one unambiguous meaning. The Docker API is the worst: unauthenticated root on the host. */
const BY_PORT: Record<number, Def> = {
  2375: d("Docker API (no TLS)", "docker", "critical"),
  2376: d("Docker API", "docker", "critical"),
  3306: d("MySQL / MariaDB", "database", "high"),
  5432: d("PostgreSQL", "database", "high"),
  1433: d("SQL Server", "database", "high"),
  27017: d("MongoDB", "database", "critical"),
  27018: d("MongoDB", "database", "critical"),
  6379: d("Redis", "cache", "critical"),
  11211: d("Memcached", "cache", "critical"),
  9200: d("Elasticsearch", "search", "critical"),
  9300: d("Elasticsearch (transport)", "search", "critical"),
  5984: d("CouchDB", "database", "critical"),
  9042: d("Cassandra", "database", "high"),
  8123: d("ClickHouse (HTTP)", "database", "high"),
  2379: d("etcd", "database", "critical"),
  5672: d("RabbitMQ", "queue", "high"),
  15672: d("RabbitMQ management", "admin", "high"),
  9092: d("Kafka", "queue", "high"),
};

/** The account a native data-store service runs as (the host scan reports the socket owner) → what it is. Catches
 *  a systemd Redis on 6482 or a MongoDB on 49157 that no port table could. Root-owned listeners are never reported. */
const BY_ACCOUNT: Record<string, Def> = {
  mysql: d("MySQL", "database", "high"),
  mariadb: d("MariaDB", "database", "high"),
  postgres: d("PostgreSQL", "database", "high"),
  mongodb: d("MongoDB", "database", "critical"),
  mongod: d("MongoDB", "database", "critical"),
  redis: d("Redis", "cache", "critical"),
  valkey: d("Valkey", "cache", "critical"),
  keydb: d("KeyDB", "cache", "critical"),
  memcache: d("Memcached", "cache", "critical"),
  memcached: d("Memcached", "cache", "critical"),
  "memcache-d": d("Memcached", "cache", "critical"),
  elasticsearch: d("Elasticsearch", "search", "critical"),
  opensearch: d("OpenSearch", "search", "critical"),
  rabbitmq: d("RabbitMQ", "queue", "high"),
  clickhouse: d("ClickHouse", "database", "high"),
  couchdb: d("CouchDB", "database", "critical"),
  cassandra: d("Cassandra", "database", "high"),
  etcd: d("etcd", "database", "critical"),
};

/** The unambiguous, scan-visible slice of a docker row this module needs. */
export interface ExposureOwner {
  name: string;
  image: string;
}

function classifyImage(image: string): Def | null {
  const last = imageSegments(image).at(-1);
  if (last && Object.prototype.hasOwnProperty.call(ADMIN_IMAGES, last)) return ADMIN_IMAGES[last];
  const sw = softwareForImage(image);
  return sw && Object.prototype.hasOwnProperty.call(BY_SOFTWARE, sw.id) ? BY_SOFTWARE[sw.id] : null;
}

const SEVERITY_RANK: Record<ExposedSeverity, number> = { critical: 0, high: 1, medium: 2 };

/**
 * The exposed services of one host. `ports` are the host scan's listening sockets (only `public` ones count; `local`
 * means bound to loopback / a private interface), `publishedBy` maps a host port to the container that publishes it.
 */
export function computeExposed(ports: { port: number; scope: "public" | "local"; user?: string }[], publishedBy: ReadonlyMap<number, ExposureOwner>): ExposedService[] {
  const out: ExposedService[] = [];
  const seen = new Set<number>();
  for (const p of ports) {
    if (p.scope !== "public" || seen.has(p.port)) continue;
    seen.add(p.port);
    const owner = publishedBy.get(p.port);
    let def: Def | null = null;
    let basis: ExposedService["basis"] = "container";
    if (owner) {
      def = classifyImage(owner.image);
      // A container the image does not identify may still sit on a well-known data-store port (a custom build).
      if (!def && Object.prototype.hasOwnProperty.call(BY_PORT, p.port)) {
        def = BY_PORT[p.port];
        basis = "port";
      }
    } else if (p.user && Object.prototype.hasOwnProperty.call(BY_ACCOUNT, p.user)) {
      def = BY_ACCOUNT[p.user];
      basis = "account";
    } else if (Object.prototype.hasOwnProperty.call(BY_PORT, p.port)) {
      def = BY_PORT[p.port];
      basis = "port";
    }
    if (!def) continue;
    out.push({
      port: p.port,
      service: def.service,
      kind: def.kind,
      severity: def.severity,
      container: owner?.name ?? null,
      basis,
      fix: def.kind === "docker" ? "docker_api" : owner ? "publish_local" : "bind_local",
    });
  }
  return out.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.port - b.port).slice(0, 60);
}
