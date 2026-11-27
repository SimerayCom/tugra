/**
 * Hand-written one-click templates. Every entry is authored from the app's official image and
 * documentation (image tag, port, volumes, environment) and compiled to a Docker Compose stack by
 * `buildExtraTemplates`. Host ports are assigned from EXTRA_PORT_BASE in list order, so only ever
 * append to EXTRA_SPECS - reordering would shift the baked ports of later entries.
 *
 * Env values may use two tokens that are baked like the importer does for its own self-URLs and later
 * swapped for the real address by `substituteSelfUrls`:
 *   {{URL}}   -> http://localhost:<hostPort>
 *   {{HOST}}  -> localhost:<hostPort>
 */
import type { SecretSpec, TemplateCategory, TemplateDef } from "./catalog";
import type { ExposePort } from "./template-manifest";

/** First host port handed to a hand-written template (generated templates use 20000+, curated < 20000). */
export const EXTRA_PORT_BASE = 21000;

type Sidecar = "postgres" | "mariadb" | "redis" | "mongo" | "clickhouse";

export interface ExtraSpec {
  slug: string;
  name: string;
  description: string;
  category: TemplateCategory;
  documentation: string;
  /** brand icon vendored as apps/web/public/icons/<slug>.svg (or .png); omit to use the monogram tile */
  icon?: boolean;
  image: string;
  /** container port the web UI listens on */
  port: number;
  env?: Record<string, string>;
  volumes?: string[]; // "name:/container/path"
  secrets?: SecretSpec[];
  command?: string[];
  /** compose healthcheck `test` array, e.g. ["CMD", "wget", ...] */
  health?: string[];
  needs?: Sidecar[];
  /** further container ports published on their own host port (not routed through the domain) */
  ports?: number[];
  /** raw YAML (2-space service indent) for additional services, plus the names the main service waits for */
  extraServices?: string;
  dependsOn?: string[];
  extraVolumes?: string[];
}

const PG = (db = "app") => `postgresql://app:\${DB_PASSWORD}@db:5432/${db}`;
const MONGO_URI = (db: string) => `mongodb://root:\${MONGO_PASSWORD}@mongo:27017/${db}?authSource=admin`;
const wget = (url: string): string[] => ["CMD", "wget", "-q", "--spider", url];
const curl = (url: string): string[] => ["CMD", "curl", "-fsS", "-o", "/dev/null", url];

export const EXTRA_SPECS: ExtraSpec[] = [
  // ── Monitoring ──
  {
    slug: "prometheus", name: "Prometheus", category: "monitoring", icon: true,
    description: "Time-series metrics database with a query language and alerting rules.",
    documentation: "https://prometheus.io/docs/",
    image: "prom/prometheus:v3.16.0", port: 9090, volumes: ["prometheus_data:/prometheus"],
    health: wget("http://127.0.0.1:9090/-/healthy"),
  },
  {
    slug: "alertmanager", name: "Alertmanager", category: "monitoring", icon: true,
    description: "Groups, deduplicates and routes Prometheus alerts to email, chat and webhooks.",
    documentation: "https://prometheus.io/docs/alerting/latest/alertmanager/",
    image: "prom/alertmanager:v0.35.1", port: 9093, volumes: ["alertmanager_data:/alertmanager"],
    health: wget("http://127.0.0.1:9093/-/healthy"),
  },
  {
    slug: "loki", name: "Loki", category: "monitoring", icon: true,
    description: "Log aggregation system that indexes labels instead of full log text.",
    documentation: "https://grafana.com/docs/loki/latest/",
    image: "grafana/loki:3.7.10", port: 3100, volumes: ["loki_data:/loki"],
  },
  {
    slug: "victoriametrics", name: "VictoriaMetrics", category: "monitoring", icon: true,
    description: "Fast time-series database that accepts Prometheus remote-write and queries.",
    documentation: "https://docs.victoriametrics.com/",
    image: "victoriametrics/victoria-metrics:v1.157.0", port: 8428, volumes: ["vm_data:/storage"],
    command: ["-storageDataPath=/storage", "-retentionPeriod=12"],
  },
  {
    slug: "jaeger", name: "Jaeger", category: "monitoring", icon: true,
    description: "Distributed tracing backend with a UI for exploring request traces.",
    documentation: "https://www.jaegertracing.io/docs/",
    image: "jaegertracing/all-in-one:1.76.0", port: 16686, ports: [4318],
    env: {
      COLLECTOR_OTLP_ENABLED: "true",
      SPAN_STORAGE_TYPE: "badger",
      BADGER_EPHEMERAL: "false",
      BADGER_DIRECTORY_VALUE: "/badger/data",
      BADGER_DIRECTORY_KEY: "/badger/key",
    },
    volumes: ["jaeger_data:/badger"],
  },
  {
    slug: "statping-ng", name: "Statping-ng", category: "monitoring",
    description: "Status page and uptime monitor for websites, APIs and TCP services.",
    documentation: "https://github.com/statping-ng/statping-ng/wiki",
    image: "adamboutcher/statping-ng:v0.90.78", port: 8080, volumes: ["statping_data:/app"],
    secrets: ["STATPING_PASSWORD", { key: "STATPING_API_SECRET", kind: "hex", len: 32 }],
    env: {
      DB_CONN: "sqlite",
      NAME: "Status",
      DESCRIPTION: "Service status",
      DOMAIN: "{{URL}}",
      ADMIN_USER: "admin",
      ADMIN_PASSWORD: "${STATPING_PASSWORD}",
      API_SECRET: "${STATPING_API_SECRET}",
    },
  },

  // ── Analytics ──
  {
    slug: "plausible", name: "Plausible", category: "analytics", icon: true,
    description: "Lightweight, cookie-free web analytics with a single-page dashboard.",
    documentation: "https://github.com/plausible/community-edition",
    image: "ghcr.io/plausible/community-edition:v2.1.5", port: 8000, needs: ["postgres", "clickhouse"],
    command: ["sh", "-c", "/entrypoint.sh db createdb && /entrypoint.sh db migrate && /entrypoint.sh run"],
    secrets: [{ key: "SECRET_KEY_BASE", kind: "alnum", len: 64 }, { key: "TOTP_VAULT_KEY", kind: "alnum", len: 43 }],
    env: {
      BASE_URL: "{{URL}}",
      SECRET_KEY_BASE: "${SECRET_KEY_BASE}",
      TOTP_VAULT_KEY: "${TOTP_VAULT_KEY}=",
      DATABASE_URL: "postgres://app:${DB_PASSWORD}@db:5432/app",
      CLICKHOUSE_DATABASE_URL: "http://clickhouse:8123/plausible_events_db",
      DISABLE_REGISTRATION: "invite_only",
    },
  },
  {
    slug: "ackee", name: "Ackee", category: "analytics",
    description: "Self-hosted analytics tool for people who care about privacy.",
    documentation: "https://github.com/electerious/Ackee/blob/master/docs/Get%20started.md",
    image: "electerious/ackee:3.7.1", port: 3000, needs: ["mongo"], secrets: ["ACKEE_PASSWORD"],
    env: {
      ACKEE_MONGODB: MONGO_URI("ackee"),
      ACKEE_USERNAME: "admin",
      ACKEE_PASSWORD: "${ACKEE_PASSWORD}",
    },
  },
  {
    slug: "cube", name: "Cube", category: "analytics",
    description: "Semantic layer that turns your database into consistent metrics and APIs.",
    documentation: "https://cube.dev/docs/product/getting-started",
    image: "cubejs/cube:v1.8.34", port: 4000, volumes: ["cube_conf:/cube/conf"],
    secrets: [{ key: "CUBEJS_API_SECRET", kind: "hex", len: 48 }],
    env: { CUBEJS_DEV_MODE: "true", CUBEJS_API_SECRET: "${CUBEJS_API_SECRET}" },
  },

  // ── Developer tools ──
  {
    slug: "gogs", name: "Gogs", category: "developer", icon: true,
    description: "Painless self-hosted Git service that runs on a small server.",
    documentation: "https://gogs.io/docs",
    image: "gogs/gogs:0.14.4", port: 3000, volumes: ["gogs_data:/data"],
  },
  {
    slug: "mailpit", name: "Mailpit", category: "developer", icon: true,
    description: "Catches outgoing email from your apps so you can read it in a web inbox.",
    documentation: "https://mailpit.axllent.org/docs/",
    image: "axllent/mailpit:v1.34.0", port: 8025, ports: [1025], volumes: ["mailpit_data:/data"],
    secrets: ["MAILPIT_PASSWORD"],
    env: {
      MP_DATABASE: "/data/mailpit.db",
      MP_UI_AUTH: "admin:${MAILPIT_PASSWORD}",
      MP_SMTP_AUTH_ACCEPT_ANY: "1",
      MP_SMTP_AUTH_ALLOW_INSECURE: "1",
    },
    health: ["CMD", "/mailpit", "readyz"],
  },
  {
    slug: "swagger-ui", name: "Swagger UI", category: "developer", icon: true,
    description: "Interactive documentation page for any OpenAPI specification.",
    documentation: "https://swagger.io/docs/open-source-tools/swagger-ui/usage/installation/",
    image: "swaggerapi/swagger-ui:v5.36.0", port: 8080, env: { BASE_URL: "/" },
  },
  {
    slug: "plantuml", name: "PlantUML Server", category: "developer", icon: true,
    description: "Renders PlantUML text diagrams to images over HTTP.",
    documentation: "https://plantuml.com/server",
    image: "plantuml/plantuml-server:jetty-v1.2026.10", port: 8080,
  },
  {
    slug: "kroki", name: "Kroki", category: "developer",
    description: "Turns diagram code from Mermaid, Graphviz, PlantUML and more into images.",
    documentation: "https://docs.kroki.io/kroki/setup/install/",
    image: "yuzutech/kroki:0.37.1", port: 8000,
  },
  {
    slug: "hasura", name: "Hasura", category: "developer", icon: true,
    description: "Instant GraphQL and REST APIs on top of a Postgres database.",
    documentation: "https://hasura.io/docs/2.0/index/",
    image: "hasura/graphql-engine:v2.51.9", port: 8080, needs: ["postgres"], secrets: ["HASURA_ADMIN_SECRET"],
    env: {
      HASURA_GRAPHQL_METADATA_DATABASE_URL: PG(),
      HASURA_GRAPHQL_ENABLE_CONSOLE: "true",
      HASURA_GRAPHQL_ADMIN_SECRET: "${HASURA_ADMIN_SECRET}",
    },
  },
  {
    slug: "bytestash", name: "ByteStash", category: "developer",
    description: "Store, organize and share code snippets.",
    documentation: "https://github.com/jordan-dalby/ByteStash/wiki",
    image: "ghcr.io/jordan-dalby/bytestash:1.6.2", port: 5000, volumes: ["bytestash_data:/data/snippets"],
    secrets: [{ key: "BYTESTASH_JWT_SECRET", kind: "hex", len: 48 }],
    env: { JWT_SECRET: "${BYTESTASH_JWT_SECRET}", TOKEN_EXPIRY: "24h", ALLOW_NEW_ACCOUNTS: "true" },
  },
  {
    slug: "rstudio", name: "RStudio Server", category: "developer", icon: true,
    description: "RStudio IDE for R in the browser, with your home folder kept on a volume.",
    documentation: "https://rocker-project.org/images/versioned/rstudio.html",
    image: "rocker/rstudio:4.6.2", port: 8787, volumes: ["rstudio_home:/home/rstudio"],
    secrets: ["RSTUDIO_PASSWORD"], env: { PASSWORD: "${RSTUDIO_PASSWORD}" },
  },

  // ── Databases ──
  {
    slug: "phpmyadmin", name: "phpMyAdmin", category: "database", icon: true,
    description: "Web interface for managing MySQL and MariaDB servers.",
    documentation: "https://docs.phpmyadmin.net/en/latest/setup.html#docker",
    image: "phpmyadmin:5.2.3", port: 80, env: { PMA_ARBITRARY: "1" },
    health: curl("http://127.0.0.1/"),
  },
  {
    slug: "mongo-express", name: "Mongo Express", category: "database", icon: true,
    description: "Web admin interface for browsing and editing a MongoDB database.",
    documentation: "https://github.com/mongo-express/mongo-express",
    image: "mongo-express:1.0.2", port: 8081, needs: ["mongo"], secrets: ["MONGO_EXPRESS_PASSWORD"],
    env: {
      ME_CONFIG_MONGODB_URL: "mongodb://root:${MONGO_PASSWORD}@mongo:27017/?authSource=admin",
      ME_CONFIG_BASICAUTH_USERNAME: "admin",
      ME_CONFIG_BASICAUTH_PASSWORD: "${MONGO_EXPRESS_PASSWORD}",
    },
  },
  {
    slug: "dbgate", name: "DbGate", category: "database", icon: true,
    description: "Database client in the browser for Postgres, MySQL, MongoDB, SQL Server and SQLite.",
    documentation: "https://docs.dbgate.io/",
    image: "dbgate/dbgate:7.3.6", port: 3000, volumes: ["dbgate_data:/root/.dbgate"],
    secrets: ["DBGATE_PASSWORD"], env: { LOGIN: "admin", PASSWORD: "${DBGATE_PASSWORD}" },
  },
  {
    slug: "pgweb", name: "Pgweb", category: "database",
    description: "Simple web client for browsing and querying PostgreSQL databases.",
    documentation: "https://github.com/sosedoff/pgweb/wiki",
    image: "sosedoff/pgweb:0.17.0", port: 8081, secrets: ["PGWEB_PASSWORD"],
    env: { PGWEB_AUTH_USER: "admin", PGWEB_AUTH_PASS: "${PGWEB_PASSWORD}" },
  },
  {
    slug: "influxdb", name: "InfluxDB", category: "database", icon: true,
    description: "Time-series database for metrics, events and sensor data.",
    documentation: "https://docs.influxdata.com/influxdb/v2/",
    image: "influxdb:2.10.1", port: 8086,
    volumes: ["influx_data:/var/lib/influxdb2", "influx_config:/etc/influxdb2"],
    secrets: ["INFLUX_PASSWORD", { key: "INFLUX_TOKEN", kind: "alnum", len: 48 }],
    env: {
      DOCKER_INFLUXDB_INIT_MODE: "setup",
      DOCKER_INFLUXDB_INIT_USERNAME: "admin",
      DOCKER_INFLUXDB_INIT_PASSWORD: "${INFLUX_PASSWORD}",
      DOCKER_INFLUXDB_INIT_ORG: "main",
      DOCKER_INFLUXDB_INIT_BUCKET: "default",
      DOCKER_INFLUXDB_INIT_ADMIN_TOKEN: "${INFLUX_TOKEN}",
    },
  },
  {
    slug: "couchdb", name: "CouchDB", category: "database", icon: true,
    description: "Document database with an HTTP API and built-in replication.",
    documentation: "https://docs.couchdb.org/en/stable/",
    image: "couchdb:3.5.3", port: 5984, volumes: ["couchdb_data:/opt/couchdb/data", "couchdb_conf:/opt/couchdb/etc/local.d"],
    secrets: ["COUCHDB_PASSWORD"], env: { COUCHDB_USER: "admin", COUCHDB_PASSWORD: "${COUCHDB_PASSWORD}" },
  },
  {
    slug: "surrealdb", name: "SurrealDB", category: "database", icon: true,
    description: "Multi-model database for documents, graphs and relational data.",
    documentation: "https://surrealdb.com/docs",
    image: "surrealdb/surrealdb:v2.7.0", port: 8000, volumes: ["surreal_data:/data"],
    secrets: ["SURREAL_PASSWORD"],
    command: ["start", "--user", "root", "--pass", "${SURREAL_PASSWORD}", "--bind", "0.0.0.0:8000", "rocksdb:/data/database.db"],
  },
  {
    slug: "arangodb", name: "ArangoDB", category: "database",
    description: "Multi-model database for documents, graphs and key-value data.",
    documentation: "https://docs.arangodb.com/stable/",
    image: "arangodb:3.12.14", port: 8529,
    volumes: ["arango_data:/var/lib/arangodb3", "arango_apps:/var/lib/arangodb3-apps"],
    secrets: ["ARANGO_ROOT_PASSWORD"], env: { ARANGO_ROOT_PASSWORD: "${ARANGO_ROOT_PASSWORD}" },
  },
  {
    slug: "neo4j", name: "Neo4j", category: "database", icon: true,
    description: "Graph database queried with Cypher, with a browser console.",
    documentation: "https://neo4j.com/docs/operations-manual/current/docker/",
    image: "neo4j:5.26.34", port: 7474, ports: [7687],
    volumes: ["neo4j_data:/data", "neo4j_logs:/logs"],
    secrets: ["NEO4J_PASSWORD"], env: { NEO4J_AUTH: "neo4j/${NEO4J_PASSWORD}" },
  },

  // ── CMS and publishing ──
  {
    slug: "drupal", name: "Drupal", category: "cms", icon: true,
    description: "Content management platform for structured sites with fine-grained permissions.",
    documentation: "https://www.drupal.org/docs/getting-started/installing-drupal",
    image: "drupal:11.4.14-apache", port: 80,
    volumes: [
      "drupal_modules:/var/www/html/modules",
      "drupal_profiles:/var/www/html/profiles",
      "drupal_themes:/var/www/html/themes",
      "drupal_sites:/var/www/html/sites",
    ],
    health: curl("http://127.0.0.1/"),
  },
  {
    slug: "grav", name: "Grav", category: "cms", icon: true,
    description: "Flat-file CMS that stores pages as Markdown files, with no database.",
    documentation: "https://learn.getgrav.org/",
    image: "lscr.io/linuxserver/grav:1.7.45", port: 80, volumes: ["grav_config:/config"],
    env: { PUID: "1000", PGID: "1000", TZ: "UTC" },
  },
  {
    slug: "prestashop", name: "PrestaShop", category: "cms",
    description: "Online store platform with catalog, checkout and order management.",
    documentation: "https://devdocs.prestashop-project.org/9/basics/installation/",
    image: "prestashop/prestashop:9.2.1", port: 80, needs: ["mariadb"], volumes: ["prestashop_data:/var/www/html"],
    secrets: ["PS_ADMIN_PASSWORD"],
    env: {
      DB_SERVER: "db",
      DB_NAME: "app",
      DB_USER: "app",
      DB_PASSWD: "${DB_PASSWORD}",
      PS_INSTALL_AUTO: "1",
      PS_DOMAIN: "{{HOST}}",
      PS_ENABLE_SSL: "0",
      PS_FOLDER_ADMIN: "admin",
      PS_FOLDER_INSTALL: "install",
      ADMIN_MAIL: "admin@example.com",
      ADMIN_PASSWD: "${PS_ADMIN_PASSWORD}",
    },
  },
  {
    slug: "answer", name: "Apache Answer", category: "cms", icon: true,
    description: "Question-and-answer platform for communities and support forums.",
    documentation: "https://answer.apache.org/docs/",
    image: "apache/answer:2.0.3", port: 80, volumes: ["answer_data:/data"],
  },
  {
    slug: "dokuwiki", name: "DokuWiki", category: "cms", icon: true,
    description: "Simple wiki that keeps pages in plain text files, with no database.",
    documentation: "https://www.dokuwiki.org/manual",
    image: "lscr.io/linuxserver/dokuwiki:version-2026-07-14c", port: 80, volumes: ["dokuwiki_config:/config"],
    env: { PUID: "1000", PGID: "1000", TZ: "UTC" },
  },
  {
    slug: "linkstack", name: "LinkStack", category: "cms", icon: true,
    description: "Personal link page with a built-in editor, like a self-hosted link-in-bio.",
    documentation: "https://docs.linkstack.org/",
    image: "linkstackorg/linkstack:v4.8.8", port: 80, volumes: ["linkstack_data:/htdocs"],
    env: { TZ: "UTC", SERVER_ADMIN: "admin@example.com" },
  },

  // ── Communication ──
  {
    slug: "roundcube", name: "Roundcube", category: "communication", icon: true,
    description: "Browser-based IMAP email client with an address book and folder management.",
    documentation: "https://github.com/roundcube/roundcubemail-docker",
    image: "roundcube/roundcubemail:1.6.15-apache", port: 80, volumes: ["roundcube_db:/var/roundcube/db"],
    env: { ROUNDCUBEMAIL_DB_TYPE: "sqlite" },
  },
  {
    slug: "element-web", name: "Element Web", category: "communication", icon: true,
    description: "Matrix chat client that runs in the browser and connects to any homeserver.",
    documentation: "https://github.com/element-hq/element-web/blob/develop/docs/install.md",
    image: "vectorim/element-web:v1.12.36", port: 80,
  },
  {
    slug: "emqx", name: "EMQX", category: "automation", icon: true,
    description: "MQTT broker for IoT devices, with a dashboard for clients and topics.",
    documentation: "https://docs.emqx.com/en/emqx/latest/",
    image: "emqx/emqx:5.8.9", port: 18083, ports: [1883],
    volumes: ["emqx_data:/opt/emqx/data", "emqx_log:/opt/emqx/log"], secrets: ["EMQX_DASHBOARD_PASSWORD"],
    env: { EMQX_DASHBOARD__DEFAULT_PASSWORD: "${EMQX_DASHBOARD_PASSWORD}" },
  },

  // ── Productivity and collaboration ──
  {
    slug: "karakeep", name: "Karakeep", category: "productivity", icon: true,
    description: "Bookmark everything: links, notes and images, with full-text search and AI tagging.",
    documentation: "https://docs.karakeep.app/",
    image: "ghcr.io/karakeep-app/karakeep:0.35.0", port: 3000, volumes: ["karakeep_data:/data"],
    secrets: [{ key: "NEXTAUTH_SECRET", kind: "alnum", len: 40 }, { key: "MEILI_MASTER_KEY", kind: "alnum", len: 40 }],
    env: {
      DATA_DIR: "/data",
      NEXTAUTH_SECRET: "${NEXTAUTH_SECRET}",
      NEXTAUTH_URL: "{{URL}}",
      MEILI_ADDR: "http://meilisearch:7700",
      MEILI_MASTER_KEY: "${MEILI_MASTER_KEY}",
      BROWSER_WEB_URL: "http://chrome:9222",
    },
    dependsOn: ["meilisearch", "chrome"],
    extraVolumes: ["meili_data"],
    extraServices: `  meilisearch:
    image: getmeili/meilisearch:v1.13.3
    restart: unless-stopped
    environment:
      MEILI_NO_ANALYTICS: "true"
      MEILI_MASTER_KEY: "\${MEILI_MASTER_KEY}"
    volumes:
      - meili_data:/meili_data
  chrome:
    image: zenika/alpine-chrome:124
    restart: unless-stopped
    command: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--remote-debugging-address=0.0.0.0", "--remote-debugging-port=9222", "--hide-scrollbars"]
`,
  },
  {
    slug: "linkwarden", name: "Linkwarden", category: "productivity",
    description: "Collect, organize and archive web pages as readable copies and screenshots.",
    documentation: "https://docs.linkwarden.app/",
    image: "ghcr.io/linkwarden/linkwarden:v2.17.0", port: 3000, needs: ["postgres"], volumes: ["linkwarden_data:/data/data"],
    secrets: [{ key: "NEXTAUTH_SECRET", kind: "alnum", len: 40 }],
    env: {
      DATABASE_URL: PG(),
      NEXTAUTH_SECRET: "${NEXTAUTH_SECRET}",
      NEXTAUTH_URL: "{{URL}}/api/v1/auth",
    },
  },
  {
    slug: "planka", name: "Planka", category: "productivity", icon: true,
    description: "Kanban boards for teams, with cards, labels, due dates and attachments.",
    documentation: "https://docs.planka.cloud/",
    image: "ghcr.io/plankanban/planka:2.3.1", port: 1337, needs: ["postgres"], volumes: ["planka_data:/app/data"],
    secrets: [{ key: "PLANKA_SECRET_KEY", kind: "hex", len: 64 }, "PLANKA_ADMIN_PASSWORD"],
    env: {
      BASE_URL: "{{URL}}",
      DATABASE_URL: "postgresql://app:${DB_PASSWORD}@db/app",
      SECRET_KEY: "${PLANKA_SECRET_KEY}",
      DEFAULT_ADMIN_EMAIL: "admin@example.com",
      DEFAULT_ADMIN_PASSWORD: "${PLANKA_ADMIN_PASSWORD}",
      DEFAULT_ADMIN_NAME: "Admin",
      DEFAULT_ADMIN_USERNAME: "admin",
    },
  },
  {
    slug: "wekan", name: "Wekan", category: "productivity", icon: true,
    description: "Kanban board with swimlanes, checklists and webhooks.",
    documentation: "https://github.com/wekan/wekan/wiki",
    image: "wekanteam/wekan:v7.99", port: 8080, needs: ["mongo"],
    env: { ROOT_URL: "{{URL}}", MONGO_URL: MONGO_URI("wekan"), PORT: "8080" },
  },
  {
    slug: "baserow", name: "Baserow", category: "productivity", icon: true,
    description: "No-code database with spreadsheet-style tables, forms and an API.",
    documentation: "https://baserow.io/docs/installation%2Finstall-with-docker",
    image: "baserow/baserow:2.4.3", port: 80, volumes: ["baserow_data:/baserow/data"],
    env: { BASEROW_PUBLIC_URL: "{{URL}}" },
  },
  {
    slug: "appsmith", name: "Appsmith", category: "developer",
    description: "Low-code builder for internal tools, dashboards and admin panels.",
    documentation: "https://docs.appsmith.com/getting-started/setup/instance-configuration",
    image: "appsmith/appsmith-ce:v1.99", port: 80, volumes: ["appsmith_stacks:/appsmith-stacks"],
    secrets: ["APPSMITH_ENCRYPTION_PASSWORD", "APPSMITH_ENCRYPTION_SALT"],
    env: {
      APPSMITH_ENCRYPTION_PASSWORD: "${APPSMITH_ENCRYPTION_PASSWORD}",
      APPSMITH_ENCRYPTION_SALT: "${APPSMITH_ENCRYPTION_SALT}",
      APPSMITH_DISABLE_TELEMETRY: "true",
    },
  },
  {
    slug: "etherpad", name: "Etherpad", category: "productivity", icon: true,
    description: "Real-time collaborative text editor for shared notes and documents.",
    documentation: "https://docs.etherpad.org/",
    image: "etherpad/etherpad:3.3.22", port: 9001, volumes: ["etherpad_var:/opt/etherpad-lite/var"],
    secrets: ["ETHERPAD_ADMIN_PASSWORD"],
    env: { ADMIN_PASSWORD: "${ETHERPAD_ADMIN_PASSWORD}", TRUST_PROXY: "true" },
  },
  {
    slug: "baikal", name: "Baikal", category: "productivity", icon: true,
    description: "Lightweight CalDAV and CardDAV server for calendars and contacts.",
    documentation: "https://sabre.io/baikal/",
    image: "ckulka/baikal:0.10.1", port: 80, volumes: ["baikal_config:/var/www/baikal/config", "baikal_data:/var/www/baikal/Specific"],
  },
  {
    slug: "onlyoffice", name: "ONLYOFFICE Docs", category: "productivity", icon: true,
    description: "Document server for editing Word, Excel and PowerPoint files from Nextcloud and other apps.",
    documentation: "https://helpcenter.onlyoffice.com/docs/installation/docs-community-install-docker.aspx",
    image: "onlyoffice/documentserver:8.3.3", port: 80,
    volumes: ["onlyoffice_data:/var/www/onlyoffice/Data", "onlyoffice_log:/var/log/onlyoffice", "onlyoffice_db:/var/lib/postgresql"],
    secrets: [{ key: "ONLYOFFICE_JWT_SECRET", kind: "alnum", len: 32 }],
    env: { JWT_ENABLED: "true", JWT_SECRET: "${ONLYOFFICE_JWT_SECRET}" },
  },
  {
    slug: "drawio", name: "draw.io", category: "productivity", icon: true,
    description: "Diagram editor for flowcharts, network maps and UML.",
    documentation: "https://www.drawio.com/doc/",
    image: "jgraph/drawio:32.7.7", port: 8080,
  },
  {
    slug: "traggo", name: "Traggo", category: "productivity", icon: true,
    description: "Tag-based time tracker with dashboards for where your hours go.",
    documentation: "https://traggo.net/",
    image: "traggo/server:0.8.3", port: 3030, volumes: ["traggo_data:/opt/traggo/data"],
    secrets: ["TRAGGO_PASSWORD"],
    env: { TRAGGO_DEFAULT_USER_NAME: "admin", TRAGGO_DEFAULT_USER_PASS: "${TRAGGO_PASSWORD}" },
  },
  {
    slug: "tandoor", name: "Tandoor Recipes", category: "productivity",
    description: "Recipe manager with meal plans, shopping lists and ingredient scaling.",
    documentation: "https://docs.tandoor.dev/",
    image: "vabene1111/recipes:2.7.8", port: 80, needs: ["postgres"],
    volumes: ["tandoor_media:/opt/recipes/mediafiles"],
    secrets: [{ key: "TANDOOR_SECRET_KEY", kind: "alnum", len: 50 }],
    env: {
      SECRET_KEY: "${TANDOOR_SECRET_KEY}",
      DB_ENGINE: "django.db.backends.postgresql",
      POSTGRES_HOST: "db",
      POSTGRES_PORT: "5432",
      POSTGRES_USER: "app",
      POSTGRES_DB: "app",
      POSTGRES_PASSWORD: "${DB_PASSWORD}",
      TZ: "UTC",
    },
  },

  // ── Files and sharing ──
  {
    slug: "filebrowser", name: "File Browser", category: "productivity", icon: true,
    description: "Web file manager with uploads, sharing links and per-user folders.",
    documentation: "https://filebrowser.org/",
    image: "filebrowser/filebrowser:v2.63.23", port: 80,
    volumes: ["filebrowser_srv:/srv", "filebrowser_db:/database", "filebrowser_config:/config"],
  },
  {
    slug: "psitransfer", name: "PsiTransfer", category: "tools", icon: true,
    description: "Simple file sharing: upload files and send a download link.",
    documentation: "https://github.com/psi-4ward/psitransfer",
    image: "psitrax/psitransfer:v2.4.6", port: 3000, volumes: ["psitransfer_data:/data"],
    secrets: ["PSITRANSFER_ADMIN_PASS"], env: { PSITRANSFER_ADMIN_PASS: "${PSITRANSFER_ADMIN_PASS}" },
  },
  {
    slug: "pingvin-share", name: "Pingvin Share", category: "tools", icon: true,
    description: "Share files with expiring links, size limits and optional reverse shares.",
    documentation: "https://stonith404.github.io/pingvin-share/introduction",
    image: "stonith404/pingvin-share:v1.13.0", port: 3000,
    volumes: ["pingvin_data:/opt/app/backend/data", "pingvin_img:/opt/app/frontend/public/img"],
  },
  {
    slug: "gokapi", name: "Gokapi", category: "tools",
    description: "Self-hosted file sharing with expiring downloads, like a private Firefox Send.",
    documentation: "https://gokapi.readthedocs.io/en/stable/",
    image: "f0rc3/gokapi:v2.2.4", port: 53842, volumes: ["gokapi_data:/app/data", "gokapi_config:/app/config"],
    env: { TZ: "UTC" },
  },
  {
    slug: "microbin", name: "MicroBin", category: "tools", icon: true,
    description: "Small pastebin and file-sharing service with expiring entries.",
    documentation: "https://microbin.eu/docs/intro/",
    image: "danielszabo99/microbin:2.1.4", port: 8080, volumes: ["microbin_data:/app/microbin_data"],
    secrets: ["MICROBIN_ADMIN_PASSWORD"],
    env: {
      MICROBIN_PORT: "8080",
      MICROBIN_PUBLIC_PATH: "{{URL}}/",
      MICROBIN_ADMIN_USERNAME: "admin",
      MICROBIN_ADMIN_PASSWORD: "${MICROBIN_ADMIN_PASSWORD}",
    },
  },

  // ── Media ──
  {
    slug: "kavita", name: "Kavita", category: "media", icon: true,
    description: "Reading server for manga, comics and books with a web reader.",
    documentation: "https://wiki.kavitareader.com/",
    image: "jvmilazz0/kavita:0.9.1", port: 5000, volumes: ["kavita_config:/kavita/config", "kavita_library:/library"],
  },
  {
    slug: "komga", name: "Komga", category: "media", icon: true,
    description: "Media server for comics, manga and magazines with OPDS support.",
    documentation: "https://komga.org/docs/",
    image: "gotson/komga:1.30.2", port: 25600, volumes: ["komga_config:/config", "komga_library:/data"],
    env: { TZ: "UTC" },
  },
  {
    slug: "tautulli", name: "Tautulli", category: "media", icon: true,
    description: "Monitoring and statistics for your Plex Media Server.",
    documentation: "https://github.com/Tautulli/Tautulli/wiki",
    image: "ghcr.io/tautulli/tautulli:v2.19.1", port: 8181, volumes: ["tautulli_config:/config"],
    env: { TZ: "UTC" },
  },
  {
    slug: "jellyseerr", name: "Jellyseerr", category: "media", icon: true,
    description: "Media request manager for Jellyfin, Emby and Plex users.",
    documentation: "https://docs.jellyseerr.dev/",
    image: "fallenbagel/jellyseerr:2.7.3", port: 5055, volumes: ["jellyseerr_config:/app/config"],
    env: { LOG_LEVEL: "info", TZ: "UTC" },
  },
  {
    slug: "handbrake", name: "HandBrake", category: "media", icon: true,
    description: "Video transcoder you control from a browser tab.",
    documentation: "https://github.com/jlesage/docker-handbrake",
    image: "jlesage/handbrake:v26.11.2", port: 5800,
    volumes: ["handbrake_config:/config", "handbrake_storage:/storage", "handbrake_output:/output"],
    secrets: ["HANDBRAKE_PASSWORD"],
    env: {
      WEB_AUTHENTICATION: "1",
      WEB_AUTHENTICATION_USERNAME: "admin",
      WEB_AUTHENTICATION_PASSWORD: "${HANDBRAKE_PASSWORD}",
    },
  },
  {
    slug: "owncast", name: "Owncast", category: "media", icon: true,
    description: "Live video streaming server with built-in chat for your own channel.",
    documentation: "https://owncast.online/docs/",
    image: "owncast/owncast:0.3.0", port: 8080, ports: [1935], volumes: ["owncast_data:/app/data"],
  },
  {
    slug: "pinchflat", name: "Pinchflat", category: "media", icon: true,
    description: "Downloads and keeps your favorite YouTube channels and playlists.",
    documentation: "https://github.com/kieraneglin/pinchflat/wiki",
    image: "ghcr.io/kieraneglin/pinchflat:v2025.6.6", port: 8945,
    volumes: ["pinchflat_config:/config", "pinchflat_downloads:/downloads"], env: { TZ: "UTC" },
  },
  {
    slug: "photoview", name: "Photoview", category: "media", icon: true,
    description: "Photo gallery that browses your folders as albums, with face grouping and maps.",
    documentation: "https://photoview.github.io/docs/",
    image: "photoview/photoview:2.4.0", port: 80,
    volumes: ["photoview_db:/app/database", "photoview_cache:/app/cache", "photoview_photos:/photos"],
    env: {
      PHOTOVIEW_DATABASE_DRIVER: "sqlite",
      PHOTOVIEW_SQLITE_PATH: "/app/database/photoview.db",
      PHOTOVIEW_MEDIA_CACHE: "/app/cache",
    },
  },
  {
    slug: "jellystat", name: "Jellystat", category: "media", icon: true,
    description: "Statistics and watch history for your Jellyfin server.",
    documentation: "https://github.com/CyferShepard/Jellystat",
    image: "cyfershepard/jellystat:1.1.12", port: 3000, needs: ["postgres"], volumes: ["jellystat_backup:/app/backend/backup-data"],
    secrets: [{ key: "JELLYSTAT_JWT_SECRET", kind: "hex", len: 48 }],
    env: {
      POSTGRES_USER: "app",
      POSTGRES_PASSWORD: "${DB_PASSWORD}",
      POSTGRES_IP: "db",
      POSTGRES_PORT: "5432",
      POSTGRES_DB: "app",
      JWT_SECRET: "${JELLYSTAT_JWT_SECRET}",
      TZ: "UTC",
    },
  },

  // ── Tools ──
  {
    slug: "whoami", name: "whoami", category: "tools",
    description: "Tiny web server that prints request headers and the container hostname.",
    documentation: "https://github.com/traefik/whoami",
    image: "traefik/whoami:v1.12.0", port: 80,
  },
  {
    slug: "openspeedtest", name: "OpenSpeedTest", category: "tools", icon: true,
    description: "Browser-based network speed test that measures against your own server.",
    documentation: "https://openspeedtest.com/",
    image: "openspeedtest/latest:v2.0.9", port: 3000,
  },
  {
    slug: "yourls", name: "YOURLS", category: "tools", icon: true,
    description: "Run your own URL shortener with click statistics.",
    documentation: "https://yourls.org/docs",
    image: "yourls:1.10.6", port: 80, needs: ["mariadb"], secrets: ["YOURLS_PASSWORD"],
    env: {
      YOURLS_DB_HOST: "db",
      YOURLS_DB_USER: "app",
      YOURLS_DB_PASS: "${DB_PASSWORD}",
      YOURLS_DB_NAME: "app",
      YOURLS_SITE: "{{URL}}",
      YOURLS_USER: "admin",
      YOURLS_PASS: "${YOURLS_PASSWORD}",
    },
  },
  {
    slug: "chhoto-url", name: "Chhoto URL", category: "tools", icon: true,
    description: "Minimal URL shortener that runs from a single small container.",
    documentation: "https://github.com/SinTan1729/chhoto-url",
    image: "sintan1729/chhoto-url:7.11.9", port: 4567, volumes: ["chhoto_data:/db"], secrets: ["CHHOTO_PASSWORD"],
    env: { password: "${CHHOTO_PASSWORD}", db_url: "/db/urls.sqlite", site_url: "{{URL}}" },
  },
  {
    slug: "shlink-web-client", name: "Shlink Web Client", category: "tools", icon: true,
    description: "Web interface for managing short links on one or more Shlink servers.",
    documentation: "https://shlink.io/documentation/shlink-web-client/",
    image: "shlinkio/shlink-web-client:4.9.1", port: 8080,
  },
  {
    slug: "traccar", name: "Traccar", category: "tools", icon: true,
    description: "GPS tracking platform that works with most vehicle and personal trackers.",
    documentation: "https://www.traccar.org/documentation/",
    image: "traccar/traccar:6.17", port: 8082, volumes: ["traccar_data:/opt/traccar/data", "traccar_logs:/opt/traccar/logs"],
  },
  {
    slug: "homer", name: "Homer", category: "tools", icon: true,
    description: "Static start page for your services, configured with one YAML file.",
    documentation: "https://github.com/bastienwirtz/homer/blob/main/docs/configuration.md",
    image: "b4bz/homer:v26.11.4", port: 8080, volumes: ["homer_assets:/www/assets"], env: { INIT_ASSETS: "1" },
  },
  {
    slug: "flame", name: "Flame", category: "tools", icon: true,
    description: "Start page with an application launcher and bookmarks you edit in the browser.",
    documentation: "https://github.com/pawelmalak/flame",
    image: "pawelmalak/flame:2.4.0", port: 5005, volumes: ["flame_data:/app/data"], secrets: ["FLAME_PASSWORD"],
    env: { PASSWORD: "${FLAME_PASSWORD}" },
  },
  {
    slug: "tika", name: "Apache Tika", category: "tools",
    description: "Extracts text and metadata from PDF, Office and hundreds of other file types over HTTP.",
    documentation: "https://tika.apache.org/",
    image: "apache/tika:4.2.0", port: 9998,
  },
  {
    slug: "octoprint", name: "OctoPrint", category: "tools", icon: true,
    description: "Web interface for controlling and monitoring a 3D printer.",
    documentation: "https://docs.octoprint.org/",
    image: "octoprint/octoprint:2.0.2", port: 80, volumes: ["octoprint_data:/octoprint"],
  },

  // ── Security and identity ──
  {
    slug: "lldap", name: "LLDAP", category: "security", icon: true,
    description: "Light LDAP server for user management, with a simple web admin UI.",
    documentation: "https://github.com/lldap/lldap",
    image: "lldap/lldap:v0.6.3", port: 17170, ports: [3890], volumes: ["lldap_data:/data"],
    secrets: [{ key: "LLDAP_JWT_SECRET", kind: "alnum", len: 40 }, { key: "LLDAP_KEY_SEED", kind: "alnum", len: 40 }, "LLDAP_ADMIN_PASSWORD"],
    env: {
      LLDAP_JWT_SECRET: "${LLDAP_JWT_SECRET}",
      LLDAP_KEY_SEED: "${LLDAP_KEY_SEED}",
      LLDAP_LDAP_USER_PASS: "${LLDAP_ADMIN_PASSWORD}",
      LLDAP_LDAP_BASE_DN: "dc=example,dc=com",
    },
  },
  {
    slug: "twofauth", name: "2FAuth", category: "security", icon: true,
    description: "Manage your two-factor authentication codes and generate them from the browser.",
    documentation: "https://docs.2fauth.app/",
    image: "2fauth/2fauth:9.0.3", port: 8000, volumes: ["twofauth_data:/2fauth"],
    secrets: [{ key: "TWOFAUTH_APP_KEY", kind: "alnum", len: 32 }],
    env: {
      APP_NAME: "2FAuth",
      APP_KEY: "${TWOFAUTH_APP_KEY}",
      APP_URL: "{{URL}}",
      SITE_OWNER: "admin@example.com",
      TRUSTED_PROXIES: "*",
    },
  },

  // ── Finance ──
  {
    slug: "ghostfolio", name: "Ghostfolio", category: "finance", icon: true,
    description: "Track stocks, ETFs and crypto holdings and see how your portfolio performs.",
    documentation: "https://github.com/ghostfolio/ghostfolio#self-hosting",
    image: "ghostfolio/ghostfolio:3.100.0", port: 3333, needs: ["postgres", "redis"],
    secrets: [{ key: "ACCESS_TOKEN_SALT", kind: "alnum", len: 32 }, { key: "GHOSTFOLIO_JWT_SECRET", kind: "alnum", len: 32 }],
    env: {
      ACCESS_TOKEN_SALT: "${ACCESS_TOKEN_SALT}",
      JWT_SECRET_KEY: "${GHOSTFOLIO_JWT_SECRET}",
      DATABASE_URL: `${PG()}?connect_timeout=300&sslmode=prefer`,
      REDIS_HOST: "redis",
      REDIS_PORT: "6379",
      REDIS_PASSWORD: "${REDIS_PASSWORD}",
    },
  },
  {
    slug: "firefly-iii", name: "Firefly III", category: "finance", icon: true,
    description: "Personal finance manager for budgets, accounts and recurring transactions.",
    documentation: "https://docs.firefly-iii.org/",
    image: "fireflyiii/core:version-6.7.12", port: 8080, needs: ["mariadb"],
    volumes: ["firefly_upload:/var/www/html/storage/upload"],
    secrets: [{ key: "FIREFLY_APP_KEY", kind: "alnum", len: 32 }, { key: "STATIC_CRON_TOKEN", kind: "alnum", len: 32 }],
    env: {
      APP_KEY: "${FIREFLY_APP_KEY}",
      APP_URL: "{{URL}}",
      SITE_OWNER: "admin@example.com",
      TZ: "UTC",
      TRUSTED_PROXIES: "**",
      STATIC_CRON_TOKEN: "${STATIC_CRON_TOKEN}",
      DB_CONNECTION: "mysql",
      DB_HOST: "db",
      DB_PORT: "3306",
      DB_DATABASE: "app",
      DB_USERNAME: "app",
      DB_PASSWORD: "${DB_PASSWORD}",
    },
  },
  {
    slug: "wallos", name: "Wallos", category: "finance", icon: true,
    description: "Track subscriptions and recurring expenses, with renewal reminders.",
    documentation: "https://github.com/ellite/Wallos",
    image: "bellamy/wallos:5.11.3", port: 80,
    volumes: ["wallos_db:/var/www/html/db", "wallos_logos:/var/www/html/images/uploads/logos"], env: { TZ: "UTC" },
  },

  // ── AI ──
  {
    slug: "ollama", name: "Ollama", category: "ai", icon: true,
    description: "Run large language models locally and call them through a simple HTTP API.",
    documentation: "https://docs.ollama.com/",
    image: "ollama/ollama:0.40.18", port: 11434, volumes: ["ollama_models:/root/.ollama"],
  },
  {
    slug: "localai", name: "LocalAI", category: "ai", icon: true,
    description: "Drop-in OpenAI-compatible API that runs models on your own hardware.",
    documentation: "https://localai.io/basics/getting_started/",
    image: "localai/localai:v3.12.1", port: 8080, volumes: ["localai_models:/models"], env: { MODELS_PATH: "/models" },
  },
  {
    slug: "librechat", name: "LibreChat", category: "ai", icon: true,
    description: "Chat interface for OpenAI, Anthropic, Google and local models with multi-user accounts.",
    documentation: "https://www.librechat.ai/docs",
    image: "ghcr.io/danny-avila/librechat:v0.8.7", port: 3080, needs: ["mongo"],
    volumes: ["librechat_images:/app/client/public/images", "librechat_uploads:/app/uploads", "librechat_logs:/app/logs"],
    secrets: [
      { key: "LIBRECHAT_JWT_SECRET", kind: "hex", len: 64 },
      { key: "LIBRECHAT_JWT_REFRESH_SECRET", kind: "hex", len: 64 },
      { key: "CREDS_KEY", kind: "hex", len: 64 },
      { key: "CREDS_IV", kind: "hex", len: 32 },
    ],
    env: {
      HOST: "0.0.0.0",
      PORT: "3080",
      MONGO_URI: MONGO_URI("LibreChat"),
      DOMAIN_CLIENT: "{{URL}}",
      DOMAIN_SERVER: "{{URL}}",
      JWT_SECRET: "${LIBRECHAT_JWT_SECRET}",
      JWT_REFRESH_SECRET: "${LIBRECHAT_JWT_REFRESH_SECRET}",
      CREDS_KEY: "${CREDS_KEY}",
      CREDS_IV: "${CREDS_IV}",
      ALLOW_REGISTRATION: "true",
      SEARCH: "false",
    },
  },
  {
    slug: "litellm", name: "LiteLLM", category: "ai",
    description: "Gateway that gives 100+ model providers one OpenAI-style API, with keys and spend limits.",
    documentation: "https://docs.litellm.ai/docs/proxy/deploy",
    image: "ghcr.io/berriai/litellm-database:main-v1.16.21", port: 4000, needs: ["postgres"],
    secrets: [{ key: "LITELLM_KEY", kind: "alnum", len: 32 }, "LITELLM_UI_PASSWORD"],
    env: {
      DATABASE_URL: PG(),
      LITELLM_MASTER_KEY: "sk-${LITELLM_KEY}",
      STORE_MODEL_IN_DB: "True",
      UI_USERNAME: "admin",
      UI_PASSWORD: "${LITELLM_UI_PASSWORD}",
    },
  },
  {
    slug: "whisper-asr", name: "Whisper ASR", category: "ai",
    description: "Speech-to-text web service built on OpenAI Whisper, with a REST API.",
    documentation: "https://ahmetoner.com/whisper-asr-webservice/",
    image: "onerahmet/openai-whisper-asr-webservice:v2.0.0", port: 9000, volumes: ["whisper_cache:/root/.cache"],
    env: { ASR_MODEL: "base", ASR_ENGINE: "openai_whisper" },
  },
  {
    slug: "kokoro-tts", name: "Kokoro TTS", category: "ai",
    description: "Text-to-speech server with an OpenAI-compatible speech endpoint, running on CPU.",
    documentation: "https://github.com/remsky/Kokoro-FastAPI",
    image: "ghcr.io/remsky/kokoro-fastapi-cpu:v0.10.0", port: 8880,
  },
];

// ── compose builder ─────────────────────────────────────────────────────────────

const q = (s: string): string => JSON.stringify(s);
const arr = (xs: string[]): string => `[${xs.map(q).join(", ")}]`;

interface SidecarDef {
  service: string;
  yaml: string;
  volume?: string;
  secrets: string[];
}

function sidecar(kind: Sidecar): SidecarDef {
  switch (kind) {
    case "postgres":
      return {
        service: "db",
        volume: "db_data",
        secrets: ["DB_PASSWORD"],
        yaml: `  db:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: app
      POSTGRES_USER: app
      POSTGRES_PASSWORD: "\${DB_PASSWORD}"
    volumes:
      - db_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app -d app"]
      interval: 10s
      timeout: 5s
      retries: 10
`,
      };
    case "mariadb":
      return {
        service: "db",
        volume: "db_data",
        secrets: ["DB_PASSWORD", "DB_ROOT_PASSWORD"],
        yaml: `  db:
    image: mariadb:11
    restart: unless-stopped
    environment:
      MARIADB_DATABASE: app
      MARIADB_USER: app
      MARIADB_PASSWORD: "\${DB_PASSWORD}"
      MARIADB_ROOT_PASSWORD: "\${DB_ROOT_PASSWORD}"
    volumes:
      - db_data:/var/lib/mysql
    healthcheck:
      test: ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"]
      interval: 10s
      timeout: 5s
      retries: 10
`,
      };
    case "redis":
      return {
        service: "redis",
        volume: "redis_data",
        secrets: ["REDIS_PASSWORD"],
        yaml: `  redis:
    image: redis:7-alpine
    restart: unless-stopped
    command: ["redis-server", "--requirepass", "\${REDIS_PASSWORD}"]
    environment:
      REDIS_PASSWORD: "\${REDIS_PASSWORD}"
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD-SHELL", "redis-cli -a \\"$$REDIS_PASSWORD\\" ping | grep -q PONG"]
      interval: 10s
      timeout: 5s
      retries: 10
`,
      };
    case "mongo":
      return {
        service: "mongo",
        volume: "mongo_data",
        secrets: ["MONGO_PASSWORD"],
        yaml: `  mongo:
    image: mongo:7
    restart: unless-stopped
    environment:
      MONGO_INITDB_ROOT_USERNAME: root
      MONGO_INITDB_ROOT_PASSWORD: "\${MONGO_PASSWORD}"
    volumes:
      - mongo_data:/data/db
    healthcheck:
      test: ["CMD", "mongosh", "--quiet", "--eval", "db.adminCommand('ping').ok"]
      interval: 10s
      timeout: 10s
      retries: 10
`,
      };
    case "clickhouse":
      return {
        service: "clickhouse",
        volume: "clickhouse_data",
        secrets: [],
        yaml: `  clickhouse:
    image: clickhouse/clickhouse-server:24.12-alpine
    restart: unless-stopped
    ulimits:
      nofile:
        soft: 262144
        hard: 262144
    volumes:
      - clickhouse_data:/var/lib/clickhouse
    healthcheck:
      test: ["CMD-SHELL", "wget --no-verbose --tries=1 -O - http://127.0.0.1:8123/ping || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 10
`,
      };
  }
}

const volName = (v: string): string => v.slice(0, v.indexOf(":"));

/** Compile one spec to a TemplateDef. `hostPorts` are the host ports for [main, ...extra ports]. */
export function compileExtra(spec: ExtraSpec, hostPorts: number[]): TemplateDef {
  const [mainHost, ...extraHosts] = hostPorts;
  const bake = (s: string): string =>
    s.split("{{URL}}").join(`http://localhost:${mainHost}`).split("{{HOST}}").join(`localhost:${mainHost}`);

  const sidecars = (spec.needs ?? []).map(sidecar);
  const secrets: SecretSpec[] = [...(spec.secrets ?? [])];
  const have = new Set(secrets.map((s) => (typeof s === "string" ? s : s.key)));
  for (const sc of sidecars) for (const key of sc.secrets) if (!have.has(key)) (secrets.push(key), have.add(key));

  const lines: string[] = ["services:", `  ${spec.slug}:`];
  lines.push(`    image: ${q(spec.image)}`);
  lines.push("    restart: unless-stopped");
  if (spec.command) lines.push(`    command: ${arr(spec.command.map(bake))}`);
  lines.push("    ports:");
  lines.push(`      - "${mainHost}:${spec.port}"`);
  (spec.ports ?? []).forEach((p, i) => lines.push(`      - "${extraHosts[i]}:${p}"`));
  if (spec.env && Object.keys(spec.env).length) {
    lines.push("    environment:");
    for (const [k, v] of Object.entries(spec.env)) lines.push(`      ${k}: ${q(bake(v))}`);
  }
  if (spec.volumes?.length) {
    lines.push("    volumes:");
    for (const v of spec.volumes) lines.push(`      - ${v}`);
  }
  const deps = [...sidecars.map((s) => [s.service, "service_healthy"]), ...(spec.dependsOn ?? []).map((d) => [d, "service_started"])];
  if (deps.length) {
    lines.push("    depends_on:");
    for (const [name, cond] of deps) lines.push(`      ${name}:`, `        condition: ${cond}`);
  }
  if (spec.health) {
    lines.push("    healthcheck:", `      test: ${arr(spec.health)}`, "      interval: 30s", "      timeout: 10s", "      retries: 5", "      start_period: 40s");
  }
  let compose = lines.join("\n") + "\n";
  for (const sc of sidecars) compose += sc.yaml;
  if (spec.extraServices) compose += spec.extraServices;

  const vols = [
    ...(spec.volumes ?? []).map(volName),
    ...sidecars.map((s) => s.volume).filter((v): v is string => !!v),
    ...(spec.extraVolumes ?? []),
  ];
  if (vols.length) compose += "volumes:\n" + [...new Set(vols)].map((v) => `  ${v}:\n`).join("");

  const exposure: ExposePort[] = [
    { serviceName: spec.slug, containerPort: spec.port, defaultMode: "domain", public: true },
    ...(spec.ports ?? []).map((p): ExposePort => ({ serviceName: spec.slug, containerPort: p, defaultMode: "hostPort", public: false })),
  ];

  const def: TemplateDef = {
    slug: spec.slug,
    name: spec.name,
    description: spec.description,
    category: spec.category,
    documentation: spec.documentation,
    composeFile: compose,
    secrets,
    exposure,
  };
  if (spec.icon) def.logo = spec.slug;
  return def;
}

/** Compile every spec, handing out host ports in list order. */
export function buildExtraTemplates(specs: ExtraSpec[] = EXTRA_SPECS): Record<string, TemplateDef> {
  const out: Record<string, TemplateDef> = {};
  let next = EXTRA_PORT_BASE;
  for (const spec of specs) {
    const count = 1 + (spec.ports?.length ?? 0);
    const ports = Array.from({ length: count }, () => next++);
    out[spec.slug] = compileExtra(spec, ports);
  }
  return out;
}

export const EXTRA_TEMPLATES: Record<string, TemplateDef> = buildExtraTemplates();
