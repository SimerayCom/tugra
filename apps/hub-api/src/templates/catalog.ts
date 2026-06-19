/**
 * Curated one-click templates. Each is a self-contained Docker Compose stack
 * (services + volumes + env in one YAML) so it reuses the existing COMPOSE
 * deploy path. `secrets` keys are filled with a random value on instantiate and
 * interpolated into the compose file via the deploy `--env-file`.
 */
import { randomBytes } from "node:crypto";

export type TemplateCategory =
  | "cms"
  | "automation"
  | "database"
  | "monitoring"
  | "tools";

export interface TemplateDef {
  slug: string;
  name: string;
  description: string;
  category: TemplateCategory;
  icon: string; // emoji
  composeFile: string;
  env?: Record<string, string>;
  secrets?: string[]; // env keys auto-filled with a generated secret
}

/** Public metadata for the gallery — never exposes composeFile or secrets. */
export interface TemplateMeta {
  slug: string;
  name: string;
  description: string;
  category: TemplateCategory;
  icon: string;
}

export const TEMPLATES: Record<string, TemplateDef> = {
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
};

/** Gallery metadata for every template (no composeFile / secrets). */
export function templateMetaList(): TemplateMeta[] {
  return Object.values(TEMPLATES).map(({ slug, name, description, category, icon }) => ({
    slug,
    name,
    description,
    category,
    icon,
  }));
}

/** A random URL/password-safe alphanumeric secret. */
export function genSecret(): string {
  return randomBytes(32).toString("base64url").replace(/[^a-zA-Z0-9]/g, "").slice(0, 24);
}

/** Resolve a template's env: static defaults + a freshly generated value per secret. */
export function buildTemplateEnv(tpl: TemplateDef): Record<string, string> {
  const env: Record<string, string> = { ...(tpl.env ?? {}) };
  for (const key of tpl.secrets ?? []) env[key] = genSecret();
  return env;
}
