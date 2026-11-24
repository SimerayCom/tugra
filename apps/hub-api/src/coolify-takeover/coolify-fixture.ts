import { CFY } from "./coolify-read-script";

/** A canned read of a small Coolify (all names are examples). Secret fields appear only as `*_present` flags, as the SQL emits them. */
export const SECTION_ROWS: Record<string, unknown[]> = {
  instance: [{ id: 0, fqdn: "https://coolify.example.com", instance_name: "Acme", public_ipv4: "203.0.113.5", smtp_password_present: true }],
  teams: [
    { id: 0, name: "Root Team", description: null, personal_team: true },
    { id: 1, name: "Acme", description: "Acme workloads", personal_team: false, discord_enabled: true, discord_webhook_url_present: true },
  ],
  team_members: [{ team_id: 0, role: "owner" }, { team_id: 1, role: "owner" }, { team_id: 1, role: "member" }],
  notify_email: [{ id: 1, team_id: 0, smtp_enabled: true, smtp_host_present: true }],
  notify_telegram: [{ id: 1, team_id: 1, telegram_enabled: false, telegram_token_present: false }],
  servers: [
    { id: 0, uuid: "srv-local", name: "localhost", ip: "host.docker.internal", port: 22, user: "root", team_id: 0, private_key_id: 1 },
    { id: 1, uuid: "srv-edge", name: "edge", ip: "198.51.100.7", port: 2222, user: "deploy", team_id: 1, private_key_id: 2 },
    { id: 2, uuid: "srv-build", name: "builder", ip: "198.51.100.8", port: 22, user: "root", team_id: 1, private_key_id: 2 },
  ],
  server_settings: [
    { server_id: 1, is_reachable: true, is_usable: true, is_build_server: false },
    { server_id: 2, is_reachable: true, is_usable: true, is_build_server: true },
  ],
  private_keys: [{ id: 1, uuid: "k1", name: "local key", team_id: 0, private_key_present: true }, { id: 2, uuid: "k2", name: "edge key", team_id: 1, private_key_present: true }],
  projects: [{ id: 1, uuid: "p1", name: "Website", description: null, team_id: 1 }],
  environments: [{ id: 1, uuid: "e1", name: "production", project_id: 1 }, { id: 2, uuid: "e2", name: "staging", project_id: 1 }],
  docker_standalone: [{ id: 0, uuid: "d0", name: "coolify", network: "coolify", server_id: 0 }, { id: 1, uuid: "d1", name: "edge", network: "edge", server_id: 1 }],
  applications: [
    {
      id: 7, uuid: "app-7", name: "web", fqdn: "https://www.example.com", git_repository: "https://github.com/acme/web.git", git_branch: "main", build_pack: "nixpacks",
      environment_id: 1, destination_id: 1, destination_type: "App\\Models\\StandaloneDocker", status: "running:healthy", docker_compose_raw_present: false,
    },
  ],
  db_postgresql: [{ id: 3, uuid: "db-3", name: "web-db", image: "postgres:16", status: "running:healthy", environment_id: 1, destination_id: 1, destination_type: "App\\Models\\StandaloneDocker", is_public: false, type: "postgresql" }],
  db_redis: [{ id: 4, uuid: "db-4", name: "cache", image: "redis:7", status: "exited", environment_id: 2, destination_id: 1, destination_type: "App\\Models\\StandaloneDocker", is_public: true, type: "redis" }],
  services: [{ id: 5, uuid: "svc-5", name: "analytics", service_type: "plausible", environment_id: 1, server_id: 1, destination_id: 1, destination_type: "App\\Models\\StandaloneDocker" }],
  service_apps: [{ id: 1, name: "plausible", service_id: 5 }],
  service_dbs: [{ id: 1, name: "clickhouse", service_id: 5 }, { id: 2, name: "postgres", service_id: 5 }],
  env_vars: [
    { id: 1, key: "NODE_ENV", is_preview: false, resourceable_type: "App\\Models\\Application", resourceable_id: 7 },
    { id: 2, key: "API_URL", is_preview: false, resourceable_type: "App\\Models\\Application", resourceable_id: 7 },
    { id: 3, key: "API_URL", is_preview: true, resourceable_type: "App\\Models\\Application", resourceable_id: 7 },
    { id: 4, key: "SERVICE_FQDN", is_preview: false, resourceable_type: "App\\Models\\Service", resourceable_id: 5 },
  ],
  shared_vars: [
    { id: 1, key: "REGION", type: "team", team_id: 1 },
    { id: 2, key: "STAGE", type: "environment", environment_id: 2 },
  ],
  scheduled_tasks: [{ id: 1, name: "nightly", frequency: "0 3 * * *", enabled: true, application_id: 7, team_id: 1, command_present: true }],
  backups: [{ id: 1, enabled: true, frequency: "0 2 * * *", save_s3: true, s3_storage_id: 1, database_id: 3, database_type: "App\\Models\\StandalonePostgresql", team_id: 1 }],
  s3: [{ id: 1, name: "offsite", bucket: "acme-backups", region: "eu-central-1", endpoint: "https://s3.example.com", team_id: 1, key_present: true, secret_present: true }],
  git_github: [{ id: 1, name: "acme-app", organization: "acme", html_url: "https://github.com", team_id: 1 }],
};

/** The script's output shape for the sections above; `skip` lists sections the version lacks. */
export function fixtureOutput(opts: { ro?: string; skip?: string[]; sections?: Record<string, unknown[]> } = {}): string {
  const sections = opts.sections ?? SECTION_ROWS;
  const lines = [`${CFY.image}ghcr.io/coollabsio/coolify:4.0.0-beta.999`, `TUGRA_CFY_RO ${opts.ro ?? "on"}`];
  for (const [name, rows] of Object.entries(sections)) {
    lines.push(`${CFY.begin}${name}`, JSON.stringify(rows), `${CFY.end}${name}`);
  }
  for (const s of opts.skip ?? []) lines.push(`${CFY.skip}${s}`);
  lines.push(CFY.done);
  return lines.join("\n");
}
