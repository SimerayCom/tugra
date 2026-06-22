/**
 * Curated one-click templates. Each is a self-contained Docker Compose stack
 * (services + volumes + env in one YAML) so it reuses the existing COMPOSE
 * deploy path. `secrets` keys are filled with a random value on instantiate and
 * interpolated into the compose file via the deploy `--env-file`.
 */
import { randomBytes } from "node:crypto";
import generated from "./catalog.generated.json";

export type TemplateCategory =
  | "cms"
  | "automation"
  | "database"
  | "monitoring"
  | "tools"
  | "analytics"
  | "security"
  | "productivity"
  | "developer"
  | "ai"
  | "media"
  | "communication"
  | "finance";

export type SecretKind = "alnum" | "hex" | "base64" | "password-symbols";

/** A secret env key: a bare string (24-char alnum) or a typed descriptor. */
export type SecretSpec =
  | string
  | { key: string; kind?: SecretKind; len?: number };

export interface TemplateDef {
  slug: string;
  name: string;
  description: string;
  category: TemplateCategory;
  icon?: string; // emoji (curated only); web renders the vendored `logo` svg
  logo?: string; // /icons/<logo>.svg filename (no extension)
  documentation?: string; // upstream docs URL (shown as a ↗ link)
  composeFile: string;
  env?: Record<string, string>;
  secrets?: SecretSpec[]; // env keys auto-filled with a generated secret
}

/** Public metadata for the gallery — never exposes composeFile or secrets. */
export interface TemplateMeta {
  slug: string;
  name: string;
  description: string;
  category: TemplateCategory;
  icon?: string;
  logo?: string;
  documentation?: string;
}

/** Hand-curated, host-port'd templates — these win over generated on slug clash. */
const CURATED: Record<string, TemplateDef> = {
  wordpress: {
    slug: "wordpress",
    name: "WordPress",
    description: "WordPress CMS with a MariaDB database.",
    category: "cms",
    icon: "📰",
    secrets: ["DB_PASSWORD", "DB_ROOT_PASSWORD"],
    composeFile: `services:
  wordpress:
    image: wordpress:6
    restart: unless-stopped
    depends_on:
      - db
    ports:
      - "8080:80"
    environment:
      WORDPRESS_DB_HOST: db
      WORDPRESS_DB_USER: wordpress
      WORDPRESS_DB_PASSWORD: \${DB_PASSWORD}
      WORDPRESS_DB_NAME: wordpress
    volumes:
      - wp_data:/var/www/html
  db:
    image: mariadb:11
    restart: unless-stopped
    environment:
      MARIADB_DATABASE: wordpress
      MARIADB_USER: wordpress
      MARIADB_PASSWORD: \${DB_PASSWORD}
      MARIADB_ROOT_PASSWORD: \${DB_ROOT_PASSWORD}
    volumes:
      - db_data:/var/lib/mysql
volumes:
  wp_data:
  db_data:
`,
  },
  ghost: {
    slug: "ghost",
    name: "Ghost",
    description: "Ghost publishing platform with a MySQL database.",
    category: "cms",
    icon: "👻",
    secrets: ["DB_PASSWORD", "DB_ROOT_PASSWORD"],
    composeFile: `services:
  ghost:
    image: ghost:5
    restart: unless-stopped
    depends_on:
      - db
    ports:
      - "2368:2368"
    environment:
      database__client: mysql
      database__connection__host: db
      database__connection__user: ghost
      database__connection__password: \${DB_PASSWORD}
      database__connection__database: ghost
    volumes:
      - ghost_data:/var/lib/ghost/content
  db:
    image: mysql:8
    restart: unless-stopped
    environment:
      MYSQL_DATABASE: ghost
      MYSQL_USER: ghost
      MYSQL_PASSWORD: \${DB_PASSWORD}
      MYSQL_ROOT_PASSWORD: \${DB_ROOT_PASSWORD}
    volumes:
      - ghost_db:/var/lib/mysql
volumes:
  ghost_data:
  ghost_db:
`,
  },
  n8n: {
    slug: "n8n",
    name: "n8n",
    description: "Workflow automation tool.",
    category: "automation",
    icon: "🔗",
    secrets: ["N8N_ENCRYPTION_KEY"],
    composeFile: `services:
  n8n:
    image: n8nio/n8n:latest
    restart: unless-stopped
    ports:
      - "5678:5678"
    environment:
      N8N_ENCRYPTION_KEY: \${N8N_ENCRYPTION_KEY}
    volumes:
      - n8n_data:/home/node/.n8n
volumes:
  n8n_data:
`,
  },
  "uptime-kuma": {
    slug: "uptime-kuma",
    name: "Uptime Kuma",
    description: "Self-hosted uptime monitoring.",
    category: "monitoring",
    icon: "📈",
    composeFile: `services:
  uptime-kuma:
    image: louislam/uptime-kuma:1
    restart: unless-stopped
    ports:
      - "3001:3001"
    volumes:
      - uptime_data:/app/data
volumes:
  uptime_data:
`,
  },
  adminer: {
    slug: "adminer",
    name: "Adminer",
    description: "Lightweight database management UI.",
    category: "tools",
    icon: "🗄️",
    composeFile: `services:
  adminer:
    image: adminer:4
    restart: unless-stopped
    ports:
      - "8081:8080"
`,
  },
  pocketbase: {
    slug: "pocketbase",
    name: "PocketBase",
    description: "Open-source backend in one file (SQLite, auth, realtime).",
    category: "developer",
    icon: "🪶",
    composeFile: `services:
  pocketbase:
    image: ghcr.io/muchobien/pocketbase:latest
    restart: unless-stopped
    ports:
      - "8090:8090"
    volumes:
      - pb_data:/pb_data
volumes:
  pb_data:
`,
  },
  gitea: {
    slug: "gitea",
    name: "Gitea",
    description: "Lightweight self-hosted Git service (SQLite).",
    category: "developer",
    icon: "🍵",
    composeFile: `services:
  gitea:
    image: gitea/gitea:1
    restart: unless-stopped
    environment:
      GITEA__database__DB_TYPE: sqlite3
    ports:
      - "3030:3000"
    volumes:
      - gitea_data:/data
volumes:
  gitea_data:
`,
  },
  directus: {
    slug: "directus",
    name: "Directus",
    description: "Headless CMS and data platform on Postgres.",
    category: "developer",
    icon: "🧩",
    secrets: ["KEY", "SECRET", "DB_PASSWORD"],
    composeFile: `services:
  directus:
    image: directus/directus:11
    restart: unless-stopped
    depends_on:
      - db
    ports:
      - "8055:8055"
    environment:
      KEY: \${KEY}
      SECRET: \${SECRET}
      DB_CLIENT: pg
      DB_HOST: db
      DB_PORT: 5432
      DB_DATABASE: directus
      DB_USER: directus
      DB_PASSWORD: \${DB_PASSWORD}
    volumes:
      - directus_uploads:/directus/uploads
  db:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: directus
      POSTGRES_USER: directus
      POSTGRES_PASSWORD: \${DB_PASSWORD}
    volumes:
      - directus_db:/var/lib/postgresql/data
volumes:
  directus_uploads:
  directus_db:
`,
  },
  umami: {
    slug: "umami",
    name: "Umami",
    description: "Privacy-friendly web analytics on Postgres.",
    category: "analytics",
    icon: "📊",
    secrets: ["DB_PASSWORD", "APP_SECRET"],
    composeFile: `services:
  umami:
    image: ghcr.io/umami-software/umami:postgresql-latest
    restart: unless-stopped
    depends_on:
      - db
    ports:
      - "3002:3000"
    environment:
      DATABASE_URL: postgresql://umami:\${DB_PASSWORD}@db:5432/umami
      DATABASE_TYPE: postgresql
      APP_SECRET: \${APP_SECRET}
  db:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: umami
      POSTGRES_USER: umami
      POSTGRES_PASSWORD: \${DB_PASSWORD}
    volumes:
      - umami_db:/var/lib/postgresql/data
volumes:
  umami_db:
`,
  },
  metabase: {
    slug: "metabase",
    name: "Metabase",
    description: "Business intelligence and dashboards (embedded H2).",
    category: "analytics",
    icon: "📈",
    composeFile: `services:
  metabase:
    image: metabase/metabase:latest
    restart: unless-stopped
    ports:
      - "3003:3000"
    environment:
      MB_DB_FILE: /metabase-data/metabase.db
    volumes:
      - metabase_data:/metabase-data
volumes:
  metabase_data:
`,
  },
  matomo: {
    slug: "matomo",
    name: "Matomo",
    description: "Open web analytics platform with a MariaDB database.",
    category: "analytics",
    icon: "🧮",
    secrets: ["DB_PASSWORD", "DB_ROOT_PASSWORD"],
    composeFile: `services:
  matomo:
    image: matomo:5
    restart: unless-stopped
    depends_on:
      - db
    ports:
      - "8082:80"
    environment:
      MATOMO_DATABASE_HOST: db
      MATOMO_DATABASE_USERNAME: matomo
      MATOMO_DATABASE_PASSWORD: \${DB_PASSWORD}
      MATOMO_DATABASE_DBNAME: matomo
    volumes:
      - matomo_data:/var/www/html
  db:
    image: mariadb:11
    restart: unless-stopped
    environment:
      MARIADB_DATABASE: matomo
      MARIADB_USER: matomo
      MARIADB_PASSWORD: \${DB_PASSWORD}
      MARIADB_ROOT_PASSWORD: \${DB_ROOT_PASSWORD}
    volumes:
      - matomo_db:/var/lib/mysql
volumes:
  matomo_data:
  matomo_db:
`,
  },
  grafana: {
    slug: "grafana",
    name: "Grafana",
    description: "Metrics and observability dashboards.",
    category: "monitoring",
    icon: "📉",
    secrets: ["GF_ADMIN_PASSWORD"],
    composeFile: `services:
  grafana:
    image: grafana/grafana:11
    restart: unless-stopped
    ports:
      - "3004:3000"
    environment:
      GF_SECURITY_ADMIN_PASSWORD: \${GF_ADMIN_PASSWORD}
    volumes:
      - grafana_data:/var/lib/grafana
volumes:
  grafana_data:
`,
  },
  vaultwarden: {
    slug: "vaultwarden",
    name: "Vaultwarden",
    description: "Lightweight Bitwarden-compatible password manager.",
    category: "security",
    icon: "🔐",
    secrets: ["ADMIN_TOKEN"],
    composeFile: `services:
  vaultwarden:
    image: vaultwarden/server:latest
    restart: unless-stopped
    ports:
      - "8083:80"
    environment:
      ADMIN_TOKEN: \${ADMIN_TOKEN}
    volumes:
      - vw_data:/data
volumes:
  vw_data:
`,
  },
  minio: {
    slug: "minio",
    name: "MinIO",
    description: "S3-compatible object storage.",
    category: "security",
    icon: "🪣",
    secrets: ["MINIO_ROOT_PASSWORD"],
    composeFile: `services:
  minio:
    image: minio/minio:latest
    restart: unless-stopped
    command: server /data --console-address ":9001"
    ports:
      - "9100:9000"
      - "9101:9001"
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: \${MINIO_ROOT_PASSWORD}
    volumes:
      - minio_data:/data
volumes:
  minio_data:
`,
  },
  nextcloud: {
    slug: "nextcloud",
    name: "Nextcloud",
    description: "Self-hosted files, calendar and collaboration suite.",
    category: "productivity",
    icon: "☁️",
    secrets: ["DB_PASSWORD", "DB_ROOT_PASSWORD"],
    composeFile: `services:
  nextcloud:
    image: nextcloud:30-apache
    restart: unless-stopped
    depends_on:
      - db
    ports:
      - "8084:80"
    environment:
      MYSQL_HOST: db
      MYSQL_DATABASE: nextcloud
      MYSQL_USER: nextcloud
      MYSQL_PASSWORD: \${DB_PASSWORD}
    volumes:
      - nc_data:/var/www/html
  db:
    image: mariadb:11
    restart: unless-stopped
    environment:
      MARIADB_DATABASE: nextcloud
      MARIADB_USER: nextcloud
      MARIADB_PASSWORD: \${DB_PASSWORD}
      MARIADB_ROOT_PASSWORD: \${DB_ROOT_PASSWORD}
    volumes:
      - nc_db:/var/lib/mysql
volumes:
  nc_data:
  nc_db:
`,
  },
  jellyfin: {
    slug: "jellyfin",
    name: "Jellyfin",
    description: "Free software media server for your movies and music.",
    category: "productivity",
    icon: "🎬",
    composeFile: `services:
  jellyfin:
    image: jellyfin/jellyfin:latest
    restart: unless-stopped
    ports:
      - "8096:8096"
    volumes:
      - jellyfin_config:/config
      - jellyfin_cache:/cache
      - jellyfin_media:/media
volumes:
  jellyfin_config:
  jellyfin_cache:
  jellyfin_media:
`,
  },
  excalidraw: {
    slug: "excalidraw",
    name: "Excalidraw",
    description: "Virtual whiteboard for sketching hand-drawn diagrams.",
    category: "productivity",
    icon: "✏️",
    composeFile: `services:
  excalidraw:
    image: excalidraw/excalidraw:latest
    restart: unless-stopped
    ports:
      - "8085:80"
`,
  },
  mealie: {
    slug: "mealie",
    name: "Mealie",
    description: "Self-hosted recipe manager and meal planner.",
    category: "productivity",
    icon: "🍲",
    composeFile: `services:
  mealie:
    image: ghcr.io/mealie-recipes/mealie:latest
    restart: unless-stopped
    ports:
      - "9925:9000"
    environment:
      ALLOW_SIGNUP: "true"
    volumes:
      - mealie_data:/app/data
volumes:
  mealie_data:
`,
  },
  wikijs: {
    slug: "wikijs",
    name: "Wiki.js",
    description: "Modern, powerful wiki on a Postgres database.",
    category: "cms",
    icon: "📚",
    secrets: ["DB_PASSWORD"],
    composeFile: `services:
  wiki:
    image: requarks/wiki:2
    restart: unless-stopped
    depends_on:
      - db
    ports:
      - "3005:3000"
    environment:
      DB_TYPE: postgres
      DB_HOST: db
      DB_PORT: 5432
      DB_USER: wiki
      DB_PASS: \${DB_PASSWORD}
      DB_NAME: wiki
  db:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: wiki
      POSTGRES_USER: wiki
      POSTGRES_PASSWORD: \${DB_PASSWORD}
    volumes:
      - wiki_db:/var/lib/postgresql/data
volumes:
  wiki_db:
`,
  },
  "node-red": {
    slug: "node-red",
    name: "Node-RED",
    description: "Low-code flow editor for event-driven automation.",
    category: "automation",
    icon: "🔴",
    composeFile: `services:
  node-red:
    image: nodered/node-red:latest
    restart: unless-stopped
    ports:
      - "1880:1880"
    volumes:
      - nodered_data:/data
volumes:
  nodered_data:
`,
  },
};

/** Bulk catalog imported from Coolify (Apache-2.0) — see scripts/import-templates.mjs. */
const GENERATED = (generated as unknown as { templates: Record<string, TemplateDef> })
  .templates;

/** Full catalog: generated bulk + curated overrides (curated wins on slug clash). */
export const TEMPLATES: Record<string, TemplateDef> = { ...GENERATED, ...CURATED };

/** Gallery metadata for every template (no composeFile / secrets). */
export function templateMetaList(): TemplateMeta[] {
  return Object.values(TEMPLATES).map(({ slug, name, description, category, icon, logo, documentation }) => ({
    slug,
    name,
    description,
    category,
    icon,
    logo,
    documentation,
  }));
}

const SECRET_SYMBOLS = "!@#$%^&*-_=+";

/** A random secret value. Default: 24-char URL/password-safe alphanumeric. */
export function genSecret(kind: SecretKind = "alnum", len = 24): string {
  const n = Math.max(len, 8);
  if (kind === "hex") return randomBytes(Math.ceil(n / 2) + 1).toString("hex").slice(0, n);
  if (kind === "base64") return randomBytes(n).toString("base64url").slice(0, n);
  const alnum = randomBytes(n * 2).toString("base64url").replace(/[^a-zA-Z0-9]/g, "");
  if (kind === "password-symbols") {
    const sym =
      SECRET_SYMBOLS[randomBytes(1)[0] % SECRET_SYMBOLS.length] +
      SECRET_SYMBOLS[randomBytes(1)[0] % SECRET_SYMBOLS.length];
    return alnum.slice(0, Math.max(n - 2, 6)) + sym;
  }
  return alnum.slice(0, n);
}

/** Resolve a template's env: static defaults + a freshly generated value per secret. */
export function buildTemplateEnv(tpl: TemplateDef): Record<string, string> {
  const env: Record<string, string> = { ...(tpl.env ?? {}) };
  for (const s of tpl.secrets ?? []) {
    if (typeof s === "string") env[s] = genSecret();
    else env[s.key] = genSecret(s.kind ?? "alnum", s.len ?? 24);
  }
  return env;
}
