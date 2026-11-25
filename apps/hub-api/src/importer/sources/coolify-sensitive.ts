import type { CoolifyResourceKind } from "./coolify-control";

/**
 * Which Coolify fields a token can see, decided from the ROW, not from the token.
 *
 * Coolify 4.7 hides every free-form command/config field from a token without `read:sensitive` (and `read:sensitive` only
 * counts when the token's creator is an admin or owner of the team): the build/install/start/pre/post-deploy commands, the
 * health-check command and response text, custom docker run options, the custom nginx configuration, `dockerfile`,
 * `custom_labels`, `docker_compose` / `docker_compose_raw`, and every database's `*_conf`. The hidden keys are REMOVED from
 * the JSON (they are not null), while a visible-but-empty field is serialized as `null`. So the presence of any such key on a
 * row proves the token can read sensitive data, and the absence of every one proves it cannot. The same test works on older
 * Coolify (4.1.2 .. 4.6), where these fields were readable with a plain `read` token: the keys are present there, so
 * the rows report `visible` and nothing is warned about.
 *
 * The importer maps this to a plan warning (build commands, health checks, labels, dockerfile and compose text could not be
 * read, so the created app would be missing them); the mapper only has to call {@link isSensitiveVisible} on the row it maps.
 */

/** Application fields hidden without read:sensitive (Application::COMMAND_AND_CONFIGURATION_ATTRIBUTES plus the text blobs). */
export const COOLIFY_APPLICATION_SENSITIVE_KEYS = [
  "install_command",
  "build_command",
  "start_command",
  "pre_deployment_command",
  "post_deployment_command",
  "health_check_command",
  "health_check_response_text",
  "custom_docker_run_options",
  "docker_compose_custom_start_command",
  "docker_compose_custom_build_command",
  "custom_nginx_configuration",
  "dockerfile",
  "custom_labels",
  "docker_compose",
  "docker_compose_raw",
] as const;

/** Database fields hidden without read:sensitive (each engine's CONFIGURATION_ATTRIBUTES; Dragonfly and ClickHouse only have `custom_docker_run_options`). */
export const COOLIFY_DATABASE_SENSITIVE_KEYS = [
  "postgres_conf",
  "mysql_conf",
  "mariadb_conf",
  "mongo_conf",
  "redis_conf",
  "keydb_conf",
  "custom_docker_run_options",
] as const;

/** Service fields hidden without read:sensitive (the compose text). */
export const COOLIFY_SERVICE_SENSITIVE_KEYS = ["docker_compose_raw", "docker_compose"] as const;

export const COOLIFY_SENSITIVE_KEYS_BY_KIND: Readonly<Record<CoolifyResourceKind, readonly string[]>> = {
  application: COOLIFY_APPLICATION_SENSITIVE_KEYS,
  database: COOLIFY_DATABASE_SENSITIVE_KEYS,
  service: COOLIFY_SERVICE_SENSITIVE_KEYS,
};

/** Every sensitive key, for a row whose kind the caller does not know. */
export const COOLIFY_SENSITIVE_KEYS: readonly string[] = [
  ...new Set<string>([...COOLIFY_APPLICATION_SENSITIVE_KEYS, ...COOLIFY_DATABASE_SENSITIVE_KEYS, ...COOLIFY_SERVICE_SENSITIVE_KEYS]),
];

/** What the mapper consumes: `hidden` = no sensitive key on the row (the token cannot read them), `visible` = at least one is present. */
export type SensitiveVisibility = "visible" | "hidden";

/** Whether this list/detail row carries the sensitive fields (see the file header). With `kind` only that kind's keys count. */
export function isSensitiveVisible(row: unknown, kind?: CoolifyResourceKind): boolean {
  if (!row || typeof row !== "object" || Array.isArray(row)) return false;
  const keys = kind ? COOLIFY_SENSITIVE_KEYS_BY_KIND[kind] : COOLIFY_SENSITIVE_KEYS;
  const r = row as Record<string, unknown>;
  // The agent read holds back the text of a sensitive column that has text and says so in `presence`: the row is a sensitive-capable one.
  if (r.presence && typeof r.presence === "object" && Object.keys(r.presence as object).some((k) => keys.includes(k))) return true;
  return keys.some((k) => Object.prototype.hasOwnProperty.call(r, k));
}

export function sensitiveVisibility(row: unknown, kind?: CoolifyResourceKind): SensitiveVisibility {
  return isSensitiveVisible(row, kind) ? "visible" : "hidden";
}

/**
 * The sensitive keys a row is missing, in a stable order: the plan warning names what the created resource will lack. Empty
 * when the row is fully visible.
 */
export function hiddenSensitiveKeys(row: unknown, kind: CoolifyResourceKind): string[] {
  if (isSensitiveVisible(row, kind)) return [];
  return [...COOLIFY_SENSITIVE_KEYS_BY_KIND[kind]];
}
