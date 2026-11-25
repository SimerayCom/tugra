import type { AgentRead, Row } from "../../coolify-takeover/coolify-agent-read";

/**
 * ONE small Coolify instance, written down twice:
 *
 *  - {@link DB_SECTIONS}: the rows the agent read returns from Coolify's database (post-SQL: soft-deleted rows are already gone,
 *    secret columns are `<column>_present` flags, secret-bearing text columns are presence flags).
 *  - {@link apiRoutes}: what Coolify's REST API answers for the same instance, written BY HAND in the API's own shape (not derived
 *    from the rows or from the mapper), so a parity test compares two independent descriptions of one instance.
 *
 * Everything is an example (no real host, address or secret). The only thing the two descriptions intentionally leave out is what the
 * sealed secret pipeline (lane B) will carry: env values, compose text, Dockerfile and label text.
 */

const T = "App\\Models\\";
const SD = "App\\Models\\StandaloneDocker";

export const DB_SECTIONS: Record<string, Row[]> = {
  teams: [
    { id: 0, name: "Root Team", description: null, personal_team: true },
    { id: 1, name: "Acme", description: "Acme workloads", personal_team: false },
    { id: 2, name: "Beta Labs", description: null, personal_team: false },
  ],
  servers: [
    { id: 0, uuid: "srv-local", name: "localhost", ip: "host.docker.internal", port: 22, user: "root", team_id: 0, private_key_id: 1, unreachable_count: 0 },
    { id: 1, uuid: "srv-edge", name: "edge", ip: "198.51.100.7", port: 2222, user: "deploy", team_id: 1, private_key_id: 2, unreachable_count: 3, server_metadata: JSON.stringify({ os: "Ubuntu", os_release: "24.04", cpus: 4 }) },
    { id: 2, uuid: "srv-build", name: "builder", ip: "198.51.100.8", port: 22, user: "root", team_id: 1, private_key_id: 2, unreachable_count: 0 },
  ],
  docker_standalone: [
    { id: 0, uuid: "d0", name: "coolify", network: "coolify", server_id: 0 },
    { id: 1, uuid: "d1", name: "edge", network: "edge-net", server_id: 1 },
    { id: 2, uuid: "d2", name: "builder", network: "builder-net", server_id: 2 },
  ],
  projects: [
    { id: 1, uuid: "p-web", name: "Website", description: "Marketing site", team_id: 1 },
    { id: 2, uuid: "p-lab", name: "Lab", description: null, team_id: 2 },
  ],
  environments: [
    { id: 10, uuid: "e-prod", name: "production", project_id: 1 },
    { id: 11, uuid: "e-stg", name: "staging", project_id: 1 },
    { id: 20, uuid: "e-lab", name: "production", project_id: 2 },
  ],
  applications: [
    {
      id: 7, uuid: "app-web", name: "web", description: null, fqdn: "https://www.example.com,http://www.example.com,https://example.com", git_repository: "acme/web", git_branch: "main",
      build_pack: "nixpacks", ports_exposes: "3000", base_directory: "/", publish_directory: null, install_command: "npm ci", build_command: "npm run build", start_command: "npm start",
      watch_paths: "src/**\n!docs/**", redirect: "www", environment_id: 10, destination_id: 1, destination_type: SD, source_id: 1, source_type: `${T}GithubApp`,
      health_check_enabled: true, health_check_path: "/up", limits_memory: "512m", limits_cpus: "1", status: "running:healthy", restart_count: 0,
      custom_labels_present: true, pre_deployment_command_present: true, custom_docker_run_options_present: false, dockerfile_present: false, docker_compose_raw_present: false,
    },
    {
      id: 8, uuid: "app-img", name: "worker", description: null, fqdn: "https://worker.example.com", git_repository: "coollabsio/coolify", git_branch: "main", build_pack: "dockerimage",
      docker_registry_image_name: "ghcr.io/acme/worker", docker_registry_image_tag: "1.4.2", ports_exposes: "8080", ports_mappings: "9000:9000", install_command: null, build_command: null, start_command: null,
      environment_id: 10, destination_id: 2, destination_type: SD, status: "running:unknown", restart_count: 12,
      custom_labels_present: false, pre_deployment_command_present: false, custom_docker_run_options_present: true, dockerfile_present: false, docker_compose_raw_present: false,
    },
    {
      id: 9, uuid: "app-stack", name: "stack", description: null, fqdn: null, git_repository: "acme/stack", git_branch: "main", build_pack: "dockercompose", ports_exposes: "80",
      docker_compose_domains: JSON.stringify({ web: { domain: "https://stack.example.com" } }), install_command: null, build_command: null, start_command: null,
      environment_id: 11, destination_id: 1, destination_type: SD, status: "exited:unhealthy", restart_count: 0,
      custom_labels_present: false, pre_deployment_command_present: false, custom_docker_run_options_present: false, dockerfile_present: false, docker_compose_raw_present: true,
    },
    {
      id: 10, uuid: "app-site", name: "docs", description: null, fqdn: "https://docs.example.com", git_repository: "acme/docs", git_branch: "main", build_pack: "nixpacks", ports_exposes: "80",
      publish_directory: "dist", install_command: "npm ci", build_command: "npm run build", start_command: null, environment_id: 20, destination_id: 1, destination_type: SD,
      status: "running:healthy", restart_count: 0, custom_labels_present: false, pre_deployment_command_present: false, custom_docker_run_options_present: false, dockerfile_present: false, docker_compose_raw_present: false,
    },
  ],
  app_settings: [
    { application_id: 7, is_static: false, is_spa: false, custom_container_name_prefix: "web-prod" },
    { application_id: 8, is_static: false, is_spa: false, custom_container_name_prefix: null },
    { application_id: 9, is_static: false, is_spa: false, custom_container_name_prefix: null },
    { application_id: 10, is_static: true, is_spa: true, custom_container_name_prefix: null },
  ],
  db_postgresql: [
    {
      id: 3, uuid: "db-pg", name: "web-db", image: "postgres:16-alpine", status: "running:healthy", environment_id: 10, destination_id: 1, destination_type: SD, is_public: true, public_port: 15432,
      postgres_user: "web", postgres_db: "web", enable_ssl: true, ssl_mode: "require", postgres_password_present: true, postgres_conf_present: true, custom_docker_run_options_present: false, type: "postgresql",
    },
  ],
  db_redis: [
    { id: 4, uuid: "db-cache", name: "cache", image: "valkey/valkey:9-alpine", status: "running:healthy", environment_id: 10, destination_id: 2, destination_type: SD, is_public: false, redis_conf_present: false, type: "redis" },
  ],
  services: [
    { id: 5, uuid: "svc-analytics", name: "analytics", description: null, service_type: "plausible", environment_id: 10, server_id: 1, destination_id: 1, destination_type: SD, docker_compose_raw_present: true },
  ],
  service_apps: [
    { id: 1, uuid: "sa-1", name: "plausible", fqdn: "https://stats.example.com", image: "ghcr.io/plausible/community-edition:v2.1", service_id: 5, status: "running:healthy" },
    { id: 2, uuid: "sa-old", name: "legacy", fqdn: null, image: "legacy:1", service_id: 5, status: "exited", is_removed_from_compose: true },
  ],
  service_dbs: [
    { id: 1, uuid: "sd-1", name: "postgres", image: "postgres:16", service_id: 5, status: "running:healthy" },
    { id: 2, uuid: "sd-2", name: "clickhouse", image: "clickhouse/clickhouse-server:24.3", service_id: 5, status: "running:healthy" },
  ],
  env_vars: [
    { id: 1, key: "NODE_ENV", is_preview: false, is_buildtime: true, is_runtime: true, is_literal: false, is_multiline: false, is_shown_once: false, resourceable_type: `${T}Application`, resourceable_id: 7, value_present: true },
    { id: 2, key: "API_URL", is_preview: false, is_buildtime: false, is_runtime: true, is_literal: true, is_multiline: false, is_shown_once: false, resourceable_type: `${T}Application`, resourceable_id: 7, value_present: true },
    { id: 3, key: "API_URL", is_preview: true, is_buildtime: false, is_runtime: true, is_literal: true, is_multiline: false, is_shown_once: false, resourceable_type: `${T}Application`, resourceable_id: 7, value_present: true },
    { id: 4, key: "TOKEN", is_preview: false, is_buildtime: false, is_runtime: true, is_literal: false, is_multiline: false, is_shown_once: true, resourceable_type: `${T}Application`, resourceable_id: 7, value_present: false },
    { id: 5, key: "REGION", is_preview: false, is_buildtime: false, is_runtime: true, is_literal: false, is_multiline: false, is_shown_once: false, resourceable_type: `${T}Application`, resourceable_id: 8, value_present: true },
  ],
  volumes: [
    { id: 1, name: "app-web-uploads", mount_path: "/app/uploads", host_path: null, resource_id: 7, resource_type: `${T}Application` },
    { id: 2, name: "worker-logs", mount_path: "/logs", host_path: "/srv/worker/logs", resource_id: 8, resource_type: `${T}Application` },
    { id: 3, name: "postgres-data-db-pg", mount_path: "/var/lib/postgresql/data", host_path: null, resource_id: 3, resource_type: `${T}StandalonePostgresql` },
  ],
  file_volumes: [{ id: 1, fs_path: "/data/coolify/services/svc-analytics/conf.toml", mount_path: "/etc/conf.toml", is_directory: false, resource_id: 5, resource_type: `${T}Service`, content_present: true }],
  s3: [{ id: 1, uuid: "s3-off", name: "offsite", region: "eu-central-1", bucket: "acme-backups", endpoint: "https://s3.example.com", team_id: 1, key_present: true, secret_present: true }],
  backups: [{ id: 1, uuid: "bk-1", enabled: true, frequency: "0 2 * * *", save_s3: true, s3_storage_id: 1, database_id: 3, database_type: `${T}StandalonePostgresql`, team_id: 1 }],
  private_keys: [{ id: 1, uuid: "k1", name: "local key", team_id: 0, private_key_present: true }, { id: 2, uuid: "k2", name: "edge key", team_id: 1, private_key_present: true }],
};

export function fixtureRead(over: Partial<AgentRead> = {}): AgentRead {
  return {
    image: "ghcr.io/coollabsio/coolify:4.0.0-beta.463",
    schemaVersion: "2025_11_20_000000_add_something",
    sections: new Map(Object.entries(DB_SECTIONS)),
    skipped: [],
    truncated: [],
    readAt: "2026-11-26T10:00:00.000Z",
    ...over,
  };
}

/**
 * Coolify's REST API for the same instance, as a token that can read the build commands and the rest of the configuration sees it:
 * only what the sealed secret pipeline carries later is absent (env values, compose text, Dockerfile and label text).
 */
export function apiRoutes(): Record<string, unknown> {
  const envs7 = [
    { key: "NODE_ENV", is_buildtime: true, is_runtime: true, is_literal: false, is_multiline: false, is_shown_once: false, is_preview: false },
    { key: "API_URL", is_buildtime: false, is_runtime: true, is_literal: true, is_multiline: false, is_shown_once: false, is_preview: false },
    { key: "API_URL", is_buildtime: false, is_runtime: true, is_literal: true, is_multiline: false, is_shown_once: false, is_preview: true },
    { key: "TOKEN", is_buildtime: false, is_runtime: true, is_literal: false, is_multiline: false, is_shown_once: true, is_preview: false },
  ];
  const apps = [
    {
      id: 7, uuid: "app-web", name: "web", description: null, fqdn: "https://www.example.com,http://www.example.com,https://example.com", git_repository: "acme/web", git_branch: "main",
      build_pack: "nixpacks", ports_exposes: "3000", base_directory: "/", publish_directory: null, install_command: "npm ci", build_command: "npm run build", start_command: "npm start",
      watch_paths: "src/**\n!docs/**", redirect: "www", environment_id: 10, destination_id: 1, destination_type: SD, source_id: 1, source_type: `${T}GithubApp`,
      health_check_enabled: true, health_check_path: "/up", limits_memory: "512m", limits_cpus: "1", status: "running:healthy", restart_count: 0,
      custom_labels: "traefik.enable=true", pre_deployment_command: "php artisan migrate", custom_docker_run_options: null, dockerfile: null, docker_compose_raw: null,
      settings: { is_static: false, is_spa: false, custom_container_name_prefix: "web-prod" },
    },
    {
      id: 8, uuid: "app-img", name: "worker", description: null, fqdn: "https://worker.example.com", git_repository: "coollabsio/coolify", git_branch: "main", build_pack: "dockerimage",
      docker_registry_image_name: "ghcr.io/acme/worker", docker_registry_image_tag: "1.4.2", ports_exposes: "8080", ports_mappings: "9000:9000", install_command: null, build_command: null, start_command: null,
      environment_id: 10, destination_id: 2, destination_type: SD, status: "running:unknown", restart_count: 12,
      custom_labels: null, pre_deployment_command: null, custom_docker_run_options: "--cap-add=NET_ADMIN", dockerfile: null, docker_compose_raw: null,
      settings: { is_static: false, is_spa: false, custom_container_name_prefix: null },
    },
    {
      id: 9, uuid: "app-stack", name: "stack", description: null, fqdn: null, git_repository: "acme/stack", git_branch: "main", build_pack: "dockercompose", ports_exposes: "80",
      docker_compose_domains: JSON.stringify({ web: { domain: "https://stack.example.com" } }), install_command: null, build_command: null, start_command: null,
      environment_id: 11, destination_id: 1, destination_type: SD, status: "exited:unhealthy", restart_count: 0,
      custom_labels: null, pre_deployment_command: null, custom_docker_run_options: null, dockerfile: null,
      settings: { is_static: false, is_spa: false, custom_container_name_prefix: null },
    },
    {
      id: 10, uuid: "app-site", name: "docs", description: null, fqdn: "https://docs.example.com", git_repository: "acme/docs", git_branch: "main", build_pack: "nixpacks", ports_exposes: "80",
      publish_directory: "dist", install_command: "npm ci", build_command: "npm run build", start_command: null, environment_id: 20, destination_id: 1, destination_type: SD,
      status: "running:healthy", restart_count: 0, custom_labels: null, pre_deployment_command: null, custom_docker_run_options: null, dockerfile: null, docker_compose_raw: null,
      settings: { is_static: true, is_spa: true, custom_container_name_prefix: null },
    },
  ];
  const databases = [
    {
      id: 3, uuid: "db-pg", name: "web-db", database_type: "standalone-postgresql", image: "postgres:16-alpine", status: "running:healthy", environment_id: 10, destination_id: 1, destination_type: SD,
      is_public: true, public_port: 15432, postgres_user: "web", postgres_db: "web", enable_ssl: true, ssl_mode: "require", postgres_conf: "max_connections=200", custom_docker_run_options: null,
    },
    { id: 4, uuid: "db-cache", name: "cache", database_type: "standalone-redis", image: "valkey/valkey:9-alpine", status: "running:healthy", environment_id: 10, destination_id: 2, destination_type: SD, is_public: false, redis_conf: null },
  ];
  const servicesList = [{ id: 5, uuid: "svc-analytics", name: "analytics", description: null, service_type: "plausible", environment_id: 10, destination_id: 1, destination_type: SD, docker_compose_raw: null }];
  return {
    "/servers": [
      { uuid: "srv-local", name: "localhost", description: null, ip: "host.docker.internal", port: 22, user: "root" },
      { uuid: "srv-edge", name: "edge", description: null, ip: "198.51.100.7", port: 2222, user: "deploy" },
      { uuid: "srv-build", name: "builder", description: null, ip: "198.51.100.8", port: 22, user: "root" },
    ],
    "/servers/srv-local": { uuid: "srv-local", name: "localhost", ip: "host.docker.internal", port: 22, user: "root", is_coolify_host: true, unreachable_count: 0 },
    "/servers/srv-edge": { uuid: "srv-edge", name: "edge", ip: "198.51.100.7", port: 2222, user: "deploy", is_coolify_host: false, unreachable_count: 3, server_metadata: { os: "Ubuntu", os_release: "24.04" } },
    "/servers/srv-build": { uuid: "srv-build", name: "builder", ip: "198.51.100.8", port: 22, user: "root", is_coolify_host: false, unreachable_count: 0 },
    "/servers/srv-local/resources": [],
    "/servers/srv-edge/resources": [{ uuid: "app-web" }, { uuid: "app-stack" }, { uuid: "app-site" }, { uuid: "db-pg" }, { uuid: "svc-analytics" }],
    "/servers/srv-build/resources": [{ uuid: "app-img" }, { uuid: "db-cache" }],
    "/applications": apps,
    "/databases": databases,
    "/services": servicesList,
    "/services/svc-analytics": {
      ...servicesList[0],
      applications: [
        { uuid: "sa-1", name: "plausible", fqdn: "https://stats.example.com", image: "ghcr.io/plausible/community-edition:v2.1" },
        { uuid: "sa-old", name: "legacy", fqdn: null, image: "legacy:1", is_removed_from_compose: true },
      ],
      databases: [
        { uuid: "sd-1", name: "postgres", image: "postgres:16" },
        { uuid: "sd-2", name: "clickhouse", image: "clickhouse/clickhouse-server:24.3" },
      ],
    },
    "/applications/app-web/envs": envs7,
    "/applications/app-img/envs": [{ key: "REGION", is_buildtime: false, is_runtime: true, is_literal: false, is_multiline: false, is_shown_once: false, is_preview: false }],
    "/applications/app-stack/envs": [],
    "/applications/app-site/envs": [],
    "/applications/app-web/storages": { persistent_storages: [{ name: "app-web-uploads", mount_path: "/app/uploads", host_path: null }], file_storages: [] },
    "/applications/app-img/storages": { persistent_storages: [{ name: "worker-logs", mount_path: "/logs", host_path: "/srv/worker/logs" }], file_storages: [] },
    "/applications/app-stack/storages": { persistent_storages: [], file_storages: [] },
    "/applications/app-site/storages": { persistent_storages: [], file_storages: [] },
    "/databases/db-pg/storages": { persistent_storages: [{ name: "postgres-data-db-pg", mount_path: "/var/lib/postgresql/data", host_path: null }], file_storages: [] },
    "/databases/db-cache/storages": { persistent_storages: [], file_storages: [] },
    "/databases/db-pg/backups": [{ enabled: true, save_s3: true, frequency: "0 2 * * *", s3_storage_id: 1, s3_storage_uuid: "s3-off" }],
    "/s3-storages": [{ id: 1, uuid: "s3-off", name: "offsite" }],
    "/projects": [
      { uuid: "p-web", name: "Website", description: "Marketing site" },
      { uuid: "p-lab", name: "Lab", description: null },
    ],
    "/projects/p-web": { uuid: "p-web", name: "Website", description: "Marketing site", environments: [{ id: 10, name: "production" }, { id: 11, name: "staging" }] },
    "/projects/p-lab": { uuid: "p-lab", name: "Lab", description: null, environments: [{ id: 20, name: "production" }] },
  };
}
