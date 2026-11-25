/**
 * The read-only SQL the agent runs inside Coolify's own Postgres container ("Read this Coolify").
 *
 * Secrets never leave Coolify's database:
 *  - Every section is ONE `select` over `to_jsonb(row)`, projected through an ALLOW-LIST of column names (`plain`). A column
 *    that is not listed is not output, and a column that does not exist in this Coolify version is simply absent (so one
 *    script reads every 4.x schema).
 *  - A column that holds a secret is reported only as `<column>_present` (a boolean). Beyond the explicit `present` list, any
 *    column whose NAME looks secret (password, token, private_key, webhook_url, api_key, ...) that is not allow-listed gets the
 *    same treatment, so a future secret column is flagged and never copied.
 *  - URL-valued columns (`scrubUrl`) lose any `user:token@` part before they are output.
 *  - Nothing is decrypted: Coolify's APP_KEY is never read.
 *
 * Every statement is a plain `select`; the script also runs psql with `default_transaction_read_only=on`, and the hub refuses
 * the result unless the server confirmed the read-only mode.
 */

export const IDENT_RE = /^[a-z_][a-z0-9_]{0,62}$/;

export interface SectionSpec {
  /** Marker name in the script output. */
  name: string;
  /** Table in the `public` schema. */
  table: string;
  /** Allow-listed columns, output as they are stored. */
  plain: string[];
  /** Allow-listed URL columns: a `user:password@` part is removed. */
  scrubUrl?: string[];
  /** Columns reported only as `<col>_present`. */
  present?: string[];
  /** Also output boolean-ish columns whose name ends with `_enabled` / `_notifications` (notification toggles). */
  toggles?: boolean;
  /** Constant keys added to every row (e.g. the database type). */
  literal?: Record<string, string>;
  limit: number;
}

/** Column names that look secret: reported as present-only unless allow-listed. */
export const SECRET_NAME_SQL_RE = "password|passwd|secret|token|private_key|webhook_url|api_key|_key$|^value$";

export function ident(v: string): string {
  if (!IDENT_RE.test(v)) throw new Error(`unsafe identifier: ${v}`);
  return v;
}
export function lit(v: string): string {
  if (!/^[A-Za-z0-9_.-]{0,64}$/.test(v)) throw new Error(`unsafe literal: ${v}`);
  return `'${v}'`;
}
export const arr = (xs: string[]): string => `array[${xs.map((x) => lit(ident(x))).join(",")}]::text[]`;

export function buildSectionSql(spec: SectionSpec): string {
  const plain = arr(spec.plain);
  const scrub = arr(spec.scrubUrl ?? []);
  const present = arr(spec.present ?? []);
  const toggle = spec.toggles ? "or e.k ~ '(_enabled|_notifications)$'" : "";
  const literal = spec.literal
    ? ` || jsonb_build_object(${Object.entries(spec.literal)
        .map(([k, v]) => `${lit(ident(k))}, ${lit(v)}`)
        .join(", ")})`
    : "";
  const limit = Math.max(1, Math.min(50_000, Math.floor(spec.limit)));
  return [
    `select coalesce(jsonb_agg(r), '[]'::jsonb)::text from (`,
    `  select (`,
    `    select coalesce(jsonb_object_agg(e.k, case when e.k = any(${scrub}) and jsonb_typeof(e.v) = 'string'`,
    `        then to_jsonb(regexp_replace(e.v #>> '{}', '://[^/@[:space:]]*@', '://', 'g')) else e.v end)`,
    `        filter (where e.k = any(${plain}) ${toggle}), '{}'::jsonb)`,
    `      || coalesce(jsonb_object_agg(e.k || '_present', (jsonb_typeof(e.v) <> 'null' and (e.v #>> '{}') <> ''))`,
    `        filter (where e.k = any(${present}) or (not e.k = any(${plain}) and e.k ~* '${SECRET_NAME_SQL_RE}')), '{}'::jsonb)${literal}`,
    `    from jsonb_each(to_jsonb(t)) as e(k, v)`,
    `  ) as r`,
    `  from public.${ident(spec.table)} t`,
    // Soft delete: Coolify keeps removed servers, applications, services and databases with `deleted_at` set. Reading the
    // column through to_jsonb keeps one script valid for a table (or version) that has no such column.
    `  where (to_jsonb(t)->>'deleted_at') is null`,
    `  order by to_jsonb(t)->>'id'`,
    `  limit ${limit}`,
    `) s;`,
  ].join("\n");
}

const DB_PLAIN = ["id", "uuid", "name", "description", "image", "status", "environment_id", "destination_id", "destination_type", "is_public", "public_port", "started_at"];
const DB_TABLES: Array<[string, string]> = [
  ["standalone_postgresqls", "postgresql"],
  ["standalone_mysqls", "mysql"],
  ["standalone_mariadbs", "mariadb"],
  ["standalone_mongodbs", "mongodb"],
  ["standalone_redis", "redis"],
  ["standalone_keydbs", "keydb"],
  ["standalone_dragonflies", "dragonfly"],
  ["standalone_clickhouses", "clickhouse"],
];

const NOTIFY = (name: string, table: string): SectionSpec => ({ name, table, plain: ["id", "team_id"], toggles: true, present: ["smtp_host", "smtp_username", "telegram_chat_id", "smtp_from_address"], limit: 1000 });

export const SECTIONS: SectionSpec[] = [
  { name: "instance", table: "instance_settings", plain: ["id", "fqdn", "instance_name", "public_ipv4", "public_ipv6", "is_auto_update_enabled", "auto_update_frequency"], scrubUrl: ["fqdn"], limit: 1 },
  { name: "teams", table: "teams", plain: ["id", "name", "description", "personal_team"], toggles: true, present: ["smtp_host", "smtp_username", "telegram_chat_id"], limit: 1000 },
  { name: "team_members", table: "team_user", plain: ["team_id", "role"], limit: 5000 },
  NOTIFY("notify_email", "email_notification_settings"),
  NOTIFY("notify_discord", "discord_notification_settings"),
  NOTIFY("notify_telegram", "telegram_notification_settings"),
  NOTIFY("notify_slack", "slack_notification_settings"),
  NOTIFY("notify_pushover", "pushover_notification_settings"),
  NOTIFY("notify_webhook", "webhook_notification_settings"),
  { name: "servers", table: "servers", plain: ["id", "uuid", "name", "description", "ip", "port", "user", "team_id", "private_key_id"], limit: 2000 },
  {
    name: "server_settings",
    table: "server_settings",
    plain: ["server_id", "is_reachable", "is_usable", "is_build_server", "is_swarm_manager", "is_swarm_worker", "wildcard_domain"],
    limit: 2000,
  },
  { name: "private_keys", table: "private_keys", plain: ["id", "uuid", "name", "description", "team_id", "is_git_related"], present: ["private_key"], limit: 2000 },
  { name: "projects", table: "projects", plain: ["id", "uuid", "name", "description", "team_id"], limit: 5000 },
  { name: "environments", table: "environments", plain: ["id", "uuid", "name", "description", "project_id"], limit: 10000 },
  { name: "docker_standalone", table: "standalone_dockers", plain: ["id", "uuid", "name", "network", "server_id"], limit: 5000 },
  { name: "docker_swarm", table: "swarm_dockers", plain: ["id", "uuid", "name", "network", "server_id"], limit: 5000 },
  {
    name: "applications",
    table: "applications",
    plain: [
      "id", "uuid", "name", "description", "fqdn", "git_repository", "git_branch", "build_pack", "ports_exposes", "base_directory", "publish_directory",
      "docker_registry_image_name", "docker_registry_image_tag", "environment_id", "destination_id", "destination_type", "source_id", "source_type",
      "private_key_id", "status", "health_check_enabled", "health_check_path", "last_online_at",
    ],
    scrubUrl: ["git_repository", "fqdn"],
    present: ["docker_compose_raw", "dockerfile", "custom_labels", "manual_webhook_secret_github", "manual_webhook_secret_gitlab"],
    limit: 10000,
  },
  ...DB_TABLES.map(([table, type]): SectionSpec => ({ name: `db_${type}`, table, plain: DB_PLAIN, literal: { type }, limit: 10000 })),
  {
    name: "services",
    table: "services",
    plain: ["id", "uuid", "name", "description", "service_type", "environment_id", "server_id", "destination_id", "destination_type"],
    present: ["docker_compose_raw"],
    limit: 10000,
  },
  { name: "service_apps", table: "service_applications", plain: ["id", "uuid", "name", "fqdn", "image", "service_id", "status"], limit: 20000 },
  { name: "service_dbs", table: "service_databases", plain: ["id", "uuid", "name", "image", "service_id", "status"], limit: 20000 },
  {
    name: "env_vars",
    table: "environment_variables",
    plain: ["id", "key", "is_preview", "is_build_time", "resourceable_type", "resourceable_id"],
    present: ["value"],
    limit: 20000,
  },
  { name: "shared_vars", table: "shared_environment_variables", plain: ["id", "key", "type", "team_id", "project_id", "environment_id"], present: ["value"], limit: 5000 },
  {
    name: "scheduled_tasks",
    table: "scheduled_tasks",
    plain: ["id", "uuid", "name", "frequency", "container", "enabled", "application_id", "service_id", "team_id"],
    present: ["command"],
    limit: 5000,
  },
  {
    name: "backups",
    table: "scheduled_database_backups",
    plain: ["id", "uuid", "enabled", "frequency", "save_s3", "s3_storage_id", "database_id", "database_type", "number_of_backups_locally", "team_id"],
    limit: 5000,
  },
  { name: "s3", table: "s3_storages", plain: ["id", "uuid", "name", "description", "region", "bucket", "endpoint", "is_usable", "team_id"], present: ["key", "secret"], scrubUrl: ["endpoint"], limit: 1000 },
  {
    name: "git_github",
    table: "github_apps",
    plain: ["id", "uuid", "name", "organization", "api_url", "html_url", "is_public", "is_system_wide", "team_id"],
    limit: 1000,
  },
  {
    name: "git_gitlab",
    table: "gitlab_apps",
    plain: ["id", "uuid", "name", "organization", "api_url", "html_url", "is_public", "is_system_wide", "team_id"],
    limit: 1000,
  },
];
