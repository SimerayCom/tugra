/**
 * The full, secret-free read of Coolify's database for the agent import path (Coolify hub takeover, lane A).
 *
 * It reuses the allow-list projection of `coolify-sql.ts` (one `select` over `to_jsonb(row)`, a column that is not listed is not
 * output, a secret-looking column becomes `<column>_present`, URL columns lose `user:token@`) and widens it to what the import
 * plan needs: build and run config, application settings, volumes, database users and ports, tags, members, git apps and S3.
 * Free-form text that can hold a secret (compose text, Dockerfile, container labels, custom Docker options, deploy hooks, custom
 * nginx text, engine `*_conf`) is reported as a presence flag only: the sealed secret pipeline (lane B) is the one way a value
 * of that kind leaves the host. Nothing here decrypts anything and APP_KEY is never read.
 *
 * Every section is guarded by `to_regclass`, so a table this Coolify version lacks only skips that section, and the whole read is
 * ONE psql session inside `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`: every section sees the same snapshot.
 */
import { buildSectionSql, ident, SECTIONS as V1_SECTIONS, type SectionSpec } from "./coolify-sql";
import { CFY } from "./coolify-read-script";

/** Output markers added by this script (the v1 markers are reused for begin/end/skip/done/image/read-only). */
export const CFYA = {
  iso: "TUGRA_CFY_ISO ",
  fail: "TUGRA_CFY_FAIL",
} as const;

/** The `migrations` table (Laravel): the newest applied migration names the schema version. */
export const SCHEMA_SECTION = "schema";

const DB_BASE = [
  "id", "uuid", "name", "description", "image", "status", "environment_id", "destination_id", "destination_type", "is_public", "public_port",
  "started_at", "ports_mappings", "restart_count", "enable_ssl", "ssl_mode", "is_log_drain_enabled",
];
/** Per engine: the user and database name columns (names, not passwords). */
const DB_IDENTITY = ["postgres_user", "postgres_db", "mysql_user", "mysql_database", "mariadb_user", "mariadb_database", "mongo_initdb_root_username", "mongo_initdb_database", "clickhouse_admin_user", "clickhouse_db"];
/** Free-form per-engine text: presence only (it can carry a password). */
export const DB_TEXT_PRESENT = ["postgres_conf", "mysql_conf", "mariadb_conf", "mongo_conf", "redis_conf", "keydb_conf", "dragonfly_conf", "custom_docker_run_options", "init_scripts"];

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

/** Application text columns that can hold a secret: presence only. */
export const APP_TEXT_PRESENT = ["docker_compose_raw", "docker_compose", "dockerfile", "custom_labels", "custom_docker_run_options", "pre_deployment_command", "post_deployment_command", "custom_nginx_configuration"] as const;

const APP_PLAIN = [
  "id", "uuid", "name", "description", "fqdn", "git_repository", "git_branch", "git_commit_sha", "build_pack", "ports_exposes", "ports_mappings",
  "base_directory", "publish_directory", "install_command", "build_command", "start_command", "dockerfile_location", "dockerfile_target_build",
  "docker_compose_location", "docker_compose_domains", "docker_compose_custom_start_command", "docker_compose_custom_build_command", "watch_paths",
  "custom_network_aliases", "docker_registry_image_name", "docker_registry_image_tag", "redirect", "is_http_basic_auth_enabled", "http_basic_auth_username",
  "health_check_enabled", "health_check_path", "health_check_port", "health_check_host", "health_check_method", "health_check_return_code", "health_check_scheme",
  "health_check_interval", "health_check_timeout", "health_check_retries", "health_check_start_period",
  "limits_memory", "limits_memory_swap", "limits_memory_swappiness", "limits_memory_reservation", "limits_cpus", "limits_cpuset", "limits_cpu_shares",
  "environment_id", "destination_id", "destination_type", "source_id", "source_type", "private_key_id", "status", "restart_count", "last_online_at",
  "is_static", "is_spa",
];

const SETTINGS_PLAIN = [
  "application_id", "is_static", "is_spa", "custom_container_name_prefix", "is_force_https_enabled", "is_gzip_enabled", "is_auto_deploy_enabled",
  "is_preview_deployments_enabled", "is_git_submodules_enabled", "is_git_lfs_enabled", "is_git_shallow_clone_enabled", "disable_build_cache", "is_gpu_enabled", "is_stripprefix_enabled", "is_permanent_redirect_enabled",
];

const GIT_APP = (name: string, table: string): SectionSpec => ({
  name,
  table,
  plain: ["id", "uuid", "name", "organization", "api_url", "html_url", "is_public", "is_system_wide", "team_id", "private_key_id", "custom_user", "custom_port"],
  limit: 1000,
});

/**
 * One notification channel's settings row (one per Coolify team). The channel's own non-secret columns (switches, recipients, host, the
 * per-event toggles) are read as they are; its token, webhook URL, key and password become `<column>_present` and travel only through
 * the sealed pipeline (class `notification`, opt-in).
 */
const NOTIFY_AGENT = (name: string, table: string, plain: string[], prefix: string): SectionSpec => ({ name, table, plain: ["id", "team_id", ...plain], prefixes: [prefix], limit: 1000 });

/** Sections the agent read adds to or replaces from the v1 list. Anything not replaced keeps its v1 definition. */
const REPLACED: SectionSpec[] = [
  { name: "team_members", table: "team_user", plain: ["team_id", "user_id", "role"], limit: 5000 },
  NOTIFY_AGENT("notify_email", "email_notification_settings", ["smtp_enabled", "resend_enabled", "use_instance_email_settings", "smtp_from_address", "smtp_from_name", "smtp_recipients", "smtp_host", "smtp_port", "smtp_encryption", "smtp_username"], "smtp_notifications_"),
  NOTIFY_AGENT("notify_discord", "discord_notification_settings", ["discord_enabled"], "discord_notifications_"),
  NOTIFY_AGENT("notify_telegram", "telegram_notification_settings", ["telegram_enabled", "telegram_chat_id"], "telegram_notifications_"),
  NOTIFY_AGENT("notify_slack", "slack_notification_settings", ["slack_enabled"], "slack_notifications_"),
  NOTIFY_AGENT("notify_pushover", "pushover_notification_settings", ["pushover_enabled"], "pushover_notifications_"),
  NOTIFY_AGENT("notify_webhook", "webhook_notification_settings", ["webhook_enabled"], "webhook_notifications_"),
  {
    name: "servers",
    table: "servers",
    plain: ["id", "uuid", "name", "description", "ip", "ip_previous", "port", "user", "team_id", "private_key_id", "unreachable_count", "server_metadata"],
    limit: 2000,
  },
  {
    name: "server_settings",
    table: "server_settings",
    plain: [
      "server_id", "is_reachable", "is_usable", "is_build_server", "is_swarm_manager", "is_swarm_worker", "is_jump_server", "is_cloudflare_tunnel", "wildcard_domain",
      // The server's own docker cleanup settings (they are settings of the team, carried by the settings import).
      "docker_cleanup_frequency", "docker_cleanup_threshold", "delete_unused_volumes", "delete_unused_networks", "force_docker_cleanup",
    ],
    limit: 2000,
  },
  { name: "applications", table: "applications", plain: APP_PLAIN, scrubUrl: ["git_repository", "fqdn"], present: [...APP_TEXT_PRESENT], limit: 20000 },
  { name: "app_settings", table: "application_settings", plain: SETTINGS_PLAIN, limit: 20000 },
  ...DB_TABLES.map(([table, type]): SectionSpec => ({ name: `db_${type}`, table, plain: [...DB_BASE, ...DB_IDENTITY], present: DB_TEXT_PRESENT, literal: { type }, limit: 20000 })),
  {
    name: "services",
    table: "services",
    plain: ["id", "uuid", "name", "description", "service_type", "environment_id", "server_id", "destination_id", "destination_type"],
    present: ["docker_compose_raw", "docker_compose"],
    limit: 20000,
  },
  { name: "service_apps", table: "service_applications", plain: ["id", "uuid", "name", "fqdn", "image", "service_id", "status", "is_removed_from_compose"], scrubUrl: ["fqdn"], limit: 50000 },
  { name: "service_dbs", table: "service_databases", plain: ["id", "uuid", "name", "image", "service_id", "status", "is_removed_from_compose"], limit: 50000 },
  {
    name: "env_vars",
    table: "environment_variables",
    // `uuid` names the row for the sealed read (ref `env:<uuid>`); it is an id, not a secret.
    plain: ["id", "uuid", "key", "is_preview", "is_build_time", "is_buildtime", "is_runtime", "is_literal", "is_multiline", "is_shown_once", "resourceable_type", "resourceable_id"],
    present: ["value"],
    limit: 100000,
  },
  {
    name: "shared_vars",
    table: "shared_environment_variables",
    plain: ["id", "uuid", "key", "type", "team_id", "project_id", "environment_id", "is_multiline", "is_literal", "is_shown_once"],
    present: ["value"],
    limit: 20000,
  },
  {
    name: "scheduled_tasks",
    table: "scheduled_tasks",
    plain: ["id", "uuid", "name", "frequency", "container", "timeout", "enabled", "application_id", "service_id", "team_id"],
    present: ["command"],
    limit: 20000,
  },
  {
    name: "backups",
    table: "scheduled_database_backups",
    plain: ["id", "uuid", "enabled", "frequency", "save_s3", "s3_storage_id", "database_id", "database_type", "databases_to_backup", "number_of_backups_locally", "team_id"],
    limit: 20000,
  },
  {
    name: "s3",
    table: "s3_storages",
    plain: ["id", "uuid", "name", "description", "region", "bucket", "endpoint", "is_usable", "team_id", "type", "use_path_style_endpoint"],
    present: ["key", "secret"],
    scrubUrl: ["endpoint"],
    limit: 2000,
  },
  GIT_APP("git_github", "github_apps"),
  GIT_APP("git_gitlab", "gitlab_apps"),
];

const ADDED: SectionSpec[] = [
  GIT_APP("git_gitea", "gitea_apps"),
  {
    name: "volumes",
    table: "local_persistent_volumes",
    plain: ["id", "name", "mount_path", "host_path", "resource_id", "resource_type"],
    limit: 100000,
  },
  {
    name: "file_volumes",
    table: "local_file_volumes",
    plain: ["id", "fs_path", "mount_path", "is_directory", "resource_id", "resource_type"],
    present: ["content"],
    limit: 100000,
  },
  // Members of a team: the user's name and email (no password, no 2FA secret: those columns are never listed and only flagged as present).
  { name: "users", table: "users", plain: ["id", "name", "email"], limit: 5000 },
  { name: "tags", table: "tags", plain: ["id", "name", "team_id"], limit: 20000 },
  { name: "taggables", table: "taggables", plain: ["tag_id", "taggable_id", "taggable_type"], limit: 100000 },
];

const REPLACED_NAMES = new Set(REPLACED.map((s) => s.name));

/** The sections of the agent read, in output order. v1 sections stay as they are unless this file replaces them. */
export const AGENT_SECTIONS: SectionSpec[] = [
  ...V1_SECTIONS.map((s) => (REPLACED_NAMES.has(s.name) ? REPLACED.find((r) => r.name === s.name)! : s)),
  ...REPLACED.filter((r) => !V1_SECTIONS.some((s) => s.name === r.name)),
  ...ADDED,
];

/** The newest applied Laravel migration (the schema version). A plain select: `migration` is a name, not a secret. */
const SCHEMA_SQL = [
  "select coalesce(jsonb_agg(r), '[]'::jsonb)::text from (",
  "  select migration, id from public.migrations order by id desc limit 1",
  ") r;",
].join("\n");

/**
 * The row cap of each section. A section is cut only when it returns MORE rows than its cap (the query asks for one row more, see
 * `probe`); the schema section is "the newest migration" by design (one row, never a cut) and has no cap here.
 */
export const sectionLimits = (): Record<string, number> => Object.fromEntries(AGENT_SECTIONS.map((s) => [s.name, Math.max(1, Math.min(50_000, Math.floor(s.limit)))] as const));

const PREAMBLE = [
  "export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  `command -v docker >/dev/null 2>&1 || { echo ${CFY.noDocker}; exit 0; }`,
  `st=$(docker inspect --format '{{.State.Running}}' coolify-db 2>/dev/null) || { echo ${CFY.noCoolify}; exit 0; }`,
  `[ "$st" = "true" ] || { echo ${CFY.stopped}; exit 0; }`,
  `case "$(docker inspect --format '{{.Config.Image}}' coolify-db 2>/dev/null)" in *postgres*) ;; *) echo ${CFY.noCoolify}; exit 0 ;; esac`,
];

/** One guarded section as psql input: look the table up first, so a table this version lacks is a skip and never an aborted transaction. */
function guarded(name: string, table: string, sql: string): string {
  return [
    `select to_regclass('public.${ident(table)}') is not null as has \\gset`,
    "\\if :has",
    `\\echo ${CFY.begin}${name}`,
    sql,
    `\\echo ${CFY.end}${name}`,
    "\\else",
    `\\echo ${CFY.skip}${name}`,
    "\\endif",
  ].join("\n");
}

/**
 * The one psql input: a single REPEATABLE READ READ ONLY transaction, the isolation and read-only facts first (the hub refuses the
 * result unless the server confirmed both), then every section. ON_ERROR_STOP: a failing statement ends the session, the DONE
 * marker is then never printed, and the hub reads that as an unreadable result instead of a partial one.
 */
export function buildAgentReadSql(): string {
  const sections = AGENT_SECTIONS.map((s) => guarded(s.name, s.table, buildSectionSql(s, { probe: true })));
  return [
    "\\set ON_ERROR_STOP on",
    "begin isolation level repeatable read read only;",
    `select '${CFY.readOnly}' || current_setting('transaction_read_only');`,
    `select '${CFYA.iso}' || current_setting('transaction_isolation');`,
    ...sections,
    guarded(SCHEMA_SECTION, "migrations", SCHEMA_SQL),
    "commit;",
  ].join("\n");
}

/**
 * The agent-read script. PARAMETERLESS, like the v1 script: nothing from a request is spliced in. It only talks to the container
 * named `coolify-db`, as the image's own database user over the local socket, in a read-only session with a statement timeout.
 */
export function buildAgentReadScript(): string {
  return [
    ...PREAMBLE,
    `printf '${CFY.image}%s\\n' "$(docker inspect --format '{{.Config.Image}}' coolify 2>/dev/null | head -c 200)"`,
    "docker exec -i -e PGOPTIONS=\"-c default_transaction_read_only=on -c statement_timeout=60000 -c idle_in_transaction_session_timeout=60000\" coolify-db sh -c 'exec psql -X -q -A -t -U \"$POSTGRES_USER\" -d \"$POSTGRES_DB\"' 2>/dev/null <<'TUGRA_CFY_SQL'",
    buildAgentReadSql(),
    "TUGRA_CFY_SQL",
    `[ $? -eq 0 ] || { echo ${CFYA.fail}; exit 0; }`,
    `echo ${CFY.done}`,
    "exit 0",
  ].join("\n");
}
