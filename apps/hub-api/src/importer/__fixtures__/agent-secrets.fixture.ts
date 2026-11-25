import type { AgentRead, Row } from "../../coolify-takeover/coolify-agent-read";
import type { SecretOverlay } from "../sources/agent-secrets";
import { fixtureRead } from "./agent-coolify.fixture";

/**
 * The agent-read fixture with what the sealed secret pipeline is about: env rows with their row uuid, shared variables, tasks, a
 * notification channel, tags, a member, cleanup settings. Every secret value is a canary string that must only ever come out through an
 * overlay (the opened values), never from the read itself.
 */
const T = "App\\Models\\";

export const CANARY = {
  nodeEnv: "CANARY-node-env-prod",
  apiUrl: "https://api.canary.test/{{not.a.ref}}",
  token: "CANARY-locked-token",
  region: "CANARY-eu-1",
  dbUrl: "postgres://app:CANARY-pw@{{team.DB_HOST}}:5432/{{environment.DB_NAME}}",
  dbHost: "CANARY-db.internal",
  dbName: "CANARY_appdb",
  svcPassword: "CANARY-svc-password",
  taskCommand: "php artisan CANARY:run",
  telegramToken: "CANARY-bot-token",
  composeStack: "services:\n  web:\n    image: CANARY-stack\n",
  composeSvc: "services:\n  plausible:\n    image: CANARY-plausible\n",
  labels: "dHJhZWZpay5lbmFibGU9Q0FOQVJZ",
  confPg: "max_connections=CANARY",
  confFile: "listen = CANARY",
} as const;

export function secretsRead(): AgentRead {
  const read = fixtureRead();
  const set = (name: string, rows: Row[]) => read.sections.set(name, rows);
  set("env_vars", [
    { id: 1, uuid: "ev1", key: "NODE_ENV", is_preview: false, is_buildtime: true, is_runtime: true, is_literal: false, is_multiline: false, is_shown_once: false, resourceable_type: `${T}Application`, resourceable_id: 7, value_present: true },
    { id: 2, uuid: "ev2", key: "API_URL", is_preview: false, is_buildtime: false, is_runtime: true, is_literal: true, is_multiline: false, is_shown_once: false, resourceable_type: `${T}Application`, resourceable_id: 7, value_present: true },
    { id: 3, uuid: "ev3", key: "API_URL", is_preview: true, is_buildtime: false, is_runtime: true, is_literal: true, is_multiline: false, is_shown_once: false, resourceable_type: `${T}Application`, resourceable_id: 7, value_present: true },
    { id: 4, uuid: "ev4", key: "TOKEN", is_preview: false, is_buildtime: false, is_runtime: true, is_literal: false, is_multiline: false, is_shown_once: true, resourceable_type: `${T}Application`, resourceable_id: 7, value_present: true },
    { id: 5, uuid: "ev5", key: "REGION", is_preview: false, is_buildtime: false, is_runtime: true, is_literal: false, is_multiline: false, is_shown_once: false, resourceable_type: `${T}Application`, resourceable_id: 8, value_present: true },
    { id: 6, uuid: "ev6", key: "EMPTY", is_preview: false, is_buildtime: false, is_runtime: true, is_literal: false, is_multiline: false, is_shown_once: false, resourceable_type: `${T}Application`, resourceable_id: 8, value_present: false },
    { id: 7, uuid: "ev7", key: "DATABASE_URL", is_preview: false, is_buildtime: false, is_runtime: true, is_literal: false, is_multiline: false, is_shown_once: false, resourceable_type: `${T}Application`, resourceable_id: 7, value_present: true },
    { id: 8, uuid: "ev8", key: "SERVICE_PASSWORD_PG", is_preview: false, is_runtime: true, is_literal: false, is_shown_once: false, resourceable_type: `${T}Service`, resourceable_id: 5, value_present: true },
    { id: 9, uuid: "ev9", key: "SERVICE_FQDN_PLAUSIBLE", is_preview: false, is_runtime: true, is_literal: false, is_shown_once: false, resourceable_type: `${T}Service`, resourceable_id: 5, value_present: true },
  ]);
  set("shared_vars", [
    { id: 1, uuid: "sh1", key: "DB_HOST", type: "team", team_id: 1, project_id: null, environment_id: null, is_multiline: false, is_literal: false, is_shown_once: false, value_present: true },
    { id: 2, uuid: "sh2", key: "DB_NAME", type: "environment", team_id: 1, project_id: 1, environment_id: 10, is_multiline: false, is_literal: false, is_shown_once: false, value_present: true },
    { id: 3, uuid: "sh3", key: "ONLY_PROJECT", type: "project", team_id: 1, project_id: 1, environment_id: null, is_multiline: false, is_literal: false, is_shown_once: true, value_present: true },
    { id: 4, uuid: "sh4", key: "OTHER_TEAM", type: "team", team_id: 2, project_id: null, environment_id: null, is_multiline: false, is_literal: false, is_shown_once: false, value_present: true },
  ]);
  set("scheduled_tasks", [
    { id: 1, uuid: "tk1", name: "nightly", frequency: "daily", container: null, timeout: 300, enabled: true, application_id: 7, service_id: null, team_id: 1, command_present: true },
    { id: 2, uuid: "tk2", name: "svc-cron", frequency: "every_minute", container: "plausible", timeout: 60, enabled: false, application_id: null, service_id: 5, team_id: 1, command_present: true },
  ]);
  set("notify_telegram", [{ id: 1, team_id: 1, telegram_enabled: true, telegram_chat_id: "424242", telegram_notifications_deployment_success: true, telegram_notifications_deployment_failure: false, telegram_token_present: true }]);
  set("notify_discord", [{ id: 1, team_id: 2, discord_enabled: true, discord_webhook_url_present: true }]);
  set("tags", [{ id: 1, name: "prod", team_id: 1 }, { id: 2, name: "lab", team_id: 2 }]);
  set("taggables", [
    { tag_id: 1, taggable_id: 7, taggable_type: `${T}Application` },
    { tag_id: 1, taggable_id: 3, taggable_type: `${T}StandalonePostgresql` },
    { tag_id: 1, taggable_id: 5, taggable_type: `${T}Service` },
  ]);
  set("users", [{ id: 5, name: "Ada", email: "ada@example.com", password_present: true }, { id: 6, name: "Lin", email: "lin@example.com" }]);
  set("team_members", [{ team_id: 1, user_id: 5, role: "owner" }, { team_id: 1, user_id: 6, role: "member" }, { team_id: 2, user_id: 6, role: "owner" }]);
  set("server_settings", [{ server_id: 1, docker_cleanup_frequency: "0 0 * * *", docker_cleanup_threshold: 80, delete_unused_volumes: true, delete_unused_networks: false, force_docker_cleanup: false }]);
  set("file_volumes", [
    { id: 11, fs_path: "/data/coolify/services/svc-analytics/conf.toml", mount_path: "/etc/conf.toml", is_directory: false, resource_id: 5, resource_type: `${T}Service`, content_present: true },
    { id: 12, fs_path: "/data/coolify/services/svc-analytics/dir", mount_path: "/etc/dir", is_directory: true, resource_id: 5, resource_type: `${T}Service`, content_present: false },
    { id: 13, fs_path: "/etc/app.conf", mount_path: "/etc/app.conf", is_directory: false, resource_id: 7, resource_type: `${T}Application`, content_present: true },
  ]);
  const apps = read.sections.get("applications")!;
  const web = apps.find((a) => a.uuid === "app-web")!;
  web.dockerfile_present = true;
  return read;
}

/** The opened values of the fixture, as an overlay. */
export const OPENED: Record<string, string> = {
  "env:ev1|value": CANARY.nodeEnv,
  "env:ev2|value": CANARY.apiUrl,
  "env:ev3|value": "CANARY-preview",
  "env:ev4|value": CANARY.token,
  "env:ev5|value": CANARY.region,
  "env:ev7|value": CANARY.dbUrl,
  "env:ev8|value": CANARY.svcPassword,
  "env:ev9|value": "https://canary.test",
  "shared_env:sh1|value": CANARY.dbHost,
  "shared_env:sh2|value": CANARY.dbName,
  "shared_env:sh3|value": "CANARY-project-only",
  "shared_env:sh4|value": "CANARY-other-team",
  "scheduled_task:tk1|command": CANARY.taskCommand,
  "scheduled_task:tk2|command": "echo CANARY-svc",
  "notification:1|telegram_token": CANARY.telegramToken,
  "application:app-stack|docker_compose_raw": CANARY.composeStack,
  "application:app-web|custom_labels": CANARY.labels,
  "application:app-web|dockerfile": "FROM node:22\n# CANARY-dockerfile\n",
  "service:svc-analytics|docker_compose_raw": CANARY.composeSvc,
  "database:db-pg|postgres_conf": CANARY.confPg,
  "file_volume:11|content": CANARY.confFile,
};

export function overlayOf(values: Record<string, string> = OPENED, without: readonly string[] = []): SecretOverlay & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    get(ref, field) {
      const k = `${ref}|${field}`;
      asked.push(k);
      return without.includes(k) ? undefined : values[k];
    },
  };
}
