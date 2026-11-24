import { TEMPLATES } from "../templates/catalog";

/**
 * What a server scan can name: a small registry of platforms, panels, web servers, runtimes and data stores,
 * plus a resolver from a container image to either one of those or a one-click template (for its name and logo).
 * `logo` is a file name in apps/web/public/icons (the same vendored set the template gallery uses); null = the
 * web shows an initials monogram instead.
 */
export type SoftwareKind = "platform" | "panel" | "web" | "runtime" | "database" | "app" | "tool";

export interface SoftwareDef {
  label: string;
  kind: SoftwareKind;
  logo: string | null;
}

const def = (label: string, kind: SoftwareKind, logo: string | null = null): SoftwareDef => ({ label, kind, logo });

export const SOFTWARE: Record<string, SoftwareDef> = {
  coolify: def("Coolify", "platform"),
  dokploy: def("Dokploy", "platform"),
  cloudpanel: def("CloudPanel", "panel"),
  cpanel: def("cPanel", "panel"),
  plesk: def("Plesk", "panel"),
  directadmin: def("DirectAdmin", "panel"),
  hestia: def("HestiaCP", "panel"),
  docker: def("Docker", "runtime"),
  pm2: def("PM2", "runtime"),
  php: def("PHP", "runtime"),
  nginx: def("nginx", "web"),
  apache: def("Apache", "web"),
  caddy: def("Caddy", "web"),
  traefik: def("Traefik", "web"),
  haproxy: def("HAProxy", "web"),
  lighttpd: def("lighttpd", "web"),
  litespeed: def("LiteSpeed", "web"),
  varnish: def("Varnish", "web"),
  postgres: def("PostgreSQL", "database", "postgresql"),
  mysql: def("MySQL", "database", "mysql"),
  mariadb: def("MariaDB", "database", "mariadb"),
  redis: def("Redis", "database", "redis"),
  valkey: def("Valkey", "database", "valkey"),
  keydb: def("KeyDB", "database", "keydb"),
  dragonfly: def("Dragonfly", "database", "dragonfly"),
  mongo: def("MongoDB", "database", "mongodb"),
  clickhouse: def("ClickHouse", "database", "clickhouse"),
  memcached: def("Memcached", "database"),
  elasticsearch: def("Elasticsearch", "database", "elasticsearch"),
  rabbitmq: def("RabbitMQ", "database", "rabbitmq"),
  meilisearch: def("Meilisearch", "database", "meilisearch"),
  minio: def("MinIO", "database", "minio"),
  typesense: def("Typesense", "database", "typesense"),
  qdrant: def("Qdrant", "database", "qdrant"),
  tailscale: def("Tailscale", "tool"),
  fail2ban: def("Fail2ban", "tool"),
};

/** A resolved piece of software: a registry id, or a template slug for a one-click app. */
export interface SoftwareRef extends SoftwareDef {
  id: string;
}

export function softwareById(id: string): SoftwareRef | null {
  const d = SOFTWARE[id];
  return d ? { id, ...d } : null;
}

/** Image base name (last path segment, no tag/digest) → registry id. */
const NAME_ALIASES: Record<string, string> = {
  postgres: "postgres",
  postgresql: "postgres",
  postgis: "postgres",
  timescaledb: "postgres",
  pgvector: "postgres",
  mysql: "mysql",
  "mysql-server": "mysql",
  mariadb: "mariadb",
  redis: "redis",
  "redis-stack": "redis",
  "redis-stack-server": "redis",
  valkey: "valkey",
  keydb: "keydb",
  dragonfly: "dragonfly",
  mongo: "mongo",
  mongodb: "mongo",
  "mongodb-community-server": "mongo",
  clickhouse: "clickhouse",
  "clickhouse-server": "clickhouse",
  memcached: "memcached",
  elasticsearch: "elasticsearch",
  rabbitmq: "rabbitmq",
  meilisearch: "meilisearch",
  minio: "minio",
  typesense: "typesense",
  qdrant: "qdrant",
  traefik: "traefik",
  nginx: "nginx",
  caddy: "caddy",
  httpd: "apache",
  apache2: "apache",
  haproxy: "haproxy",
  varnish: "varnish",
  dokploy: "dokploy",
  coolify: "coolify",
  "coolify-realtime": "coolify",
  "coolify-helper": "coolify",
  "coolify-sentinel": "coolify",
};

/** Image names that are generic on their own; the owner segment identifies the product (`vaultwarden/server`). */
const GENERIC_LAST = new Set(["server", "app", "web", "core", "community", "ce", "oss", "backend", "frontend"]);
const SUFFIXES = ["-server", "-ce", "-community", "-oss", "-app", "-web", "-core"];

/** Split an image reference into path segments without the registry host, tag or digest. */
export function imageSegments(image: string): string[] {
  const noDigest = (image.split("@")[0] ?? "").toLowerCase();
  const lastSlash = noDigest.lastIndexOf("/");
  const colon = noDigest.indexOf(":", lastSlash + 1);
  const repo = colon === -1 ? noDigest : noDigest.slice(0, colon);
  const parts = repo.split("/").filter(Boolean);
  if (parts.length > 1 && (parts[0].includes(".") || parts[0].includes(":") || parts[0] === "localhost")) parts.shift();
  return parts;
}

/**
 * Recognise what a container image is: a registry entry first (databases, proxies, platforms), then a one-click
 * template whose slug matches the image name (which brings its display name and logo). Unknown images are null: the
 * report lists the container but never invents software for it.
 */
export function softwareForImage(image: string): SoftwareRef | null {
  const parts = imageSegments(image);
  const last = parts[parts.length - 1];
  if (!last) return null;
  const owner = parts.length > 1 ? parts[parts.length - 2] : null;

  if (owner === "dokploy" && last === "dokploy") return softwareById("dokploy");
  if (owner === "coollabsio" && last.startsWith("coolify")) return softwareById("coolify");
  if (last.startsWith("immich")) return templateRef("immich");
  const alias = NAME_ALIASES[last];
  if (alias) return softwareById(alias);

  const candidates = [last];
  for (const s of SUFFIXES) if (last.endsWith(s)) candidates.push(last.slice(0, -s.length));
  if (owner && GENERIC_LAST.has(last)) candidates.push(owner);
  for (const c of candidates) {
    const a = NAME_ALIASES[c];
    if (a && c !== last) return softwareById(a);
    const t = templateRef(c);
    if (t) return t;
  }
  return null;
}

function templateRef(slug: string): SoftwareRef | null {
  if (!Object.prototype.hasOwnProperty.call(TEMPLATES, slug)) return null;
  const tpl = TEMPLATES[slug];
  return { id: slug, label: tpl.name, kind: "app", logo: tpl.logo ?? slug };
}

/** Host markers the agent scan reports → registry id. */
export const MARKER_SOFTWARE: Record<string, string> = {
  coolify: "coolify",
  dokploy: "dokploy",
  cloudpanel: "cloudpanel",
  cpanel: "cpanel",
  plesk: "plesk",
  directadmin: "directadmin",
  hestia: "hestia",
  tailscale: "tailscale",
  pm2: "pm2",
  nginx: "nginx",
  apache: "apache",
  caddy: "caddy",
};

/** systemd unit → registry id (php-fpm and pm2-<user> units are matched by pattern in {@link softwareForUnit}). */
const UNIT_SOFTWARE: Record<string, string> = {
  nginx: "nginx",
  apache2: "apache",
  httpd: "apache",
  caddy: "caddy",
  traefik: "traefik",
  haproxy: "haproxy",
  lighttpd: "lighttpd",
  lsws: "litespeed",
  varnish: "varnish",
  mysql: "mysql",
  mysqld: "mysql",
  mariadb: "mariadb",
  postgresql: "postgres",
  redis: "redis",
  "redis-server": "redis",
  valkey: "valkey",
  "valkey-server": "valkey",
  mongod: "mongo",
  memcached: "memcached",
  "clickhouse-server": "clickhouse",
  elasticsearch: "elasticsearch",
  "rabbitmq-server": "rabbitmq",
  docker: "docker",
  tailscaled: "tailscale",
  fail2ban: "fail2ban",
  cpanel: "cpanel",
  "sw-cp-server": "plesk",
  directadmin: "directadmin",
};

export function softwareForUnit(unit: string): string | null {
  if (UNIT_SOFTWARE[unit]) return UNIT_SOFTWARE[unit];
  if (/^php(\d+(\.\d+)?)?-fpm$/.test(unit)) return "php";
  if (/^pm2-/.test(unit)) return "pm2";
  return null;
}

/** Well-known listening ports → a plain service name (only where the port is unambiguous). */
export const WELL_KNOWN_PORTS: Record<number, string> = {
  22: "SSH",
  80: "HTTP",
  443: "HTTPS",
  3306: "MySQL",
  5432: "PostgreSQL",
  6379: "Redis",
  27017: "MongoDB",
  9200: "Elasticsearch",
  5672: "RabbitMQ",
  11211: "Memcached",
  2083: "cPanel",
  2087: "WHM",
};
