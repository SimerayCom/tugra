/**
 * Reasons the importer reports for what it could not carry or apply. Every entry is `{ field, reason }` plus a stable
 * `reasonCode` and its `reasonParams`: the web translates the code (`import.reason_<code>`), `reason` is the English
 * fallback (old persisted rows have no code, other API consumers read the text). Field NAMES, fixed texts and numbers
 * only: never a value (an env value, a label value or a command can carry credentials).
 */
import type { ImportReasonCode } from "@tugra/shared";

export type ReasonParams = Record<string, string | number>;

// a type alias (not an interface) so it stays assignable to Prisma's JSON input types
export type Reasoned = {
  reason: string;
  reasonCode?: ImportReasonCode;
  reasonParams?: ReasonParams;
};

/** One "not carried / could not apply" entry. */
export type Unmapped = { field: string } & Reasoned;

/** The English text per code, with `{param}` placeholders (the web's en/import.json carries the same templates). */
export const REASON_EN: Record<ImportReasonCode, string> = {
  label_invalid_key: "invalid label key",
  label_reserved_traefik: "in the reserved traefik.* namespace (owned by Tugra's ingress routing and would hijack shared proxy routes)",
  label_reserved_tugra: "in the reserved tugra.* namespace (Tugra's own bookkeeping labels)",
  label_reserved_compose: "in the reserved com.docker.compose.* namespace (Docker Compose project/service identity)",
  label_reserved_swarm: "in the reserved com.docker.swarm.* namespace (Docker Swarm service identity)",
  label_reserved_stack: "in the reserved com.docker.stack.* namespace (Docker stack identity)",
  label_duplicate: "duplicate (label keys are case-insensitive)",
  label_value_too_long: "value is longer than {max} characters",
  label_value_control: "value contains control characters",
  label_over_limit: "over the per-app label limit",
  labels_more: "{n} more not carried",
  labels_rejected: "Tugra rejected the label set",
  trigger_tag: "tag-triggered deploys have no Tugra equivalent (push only) — auto-deploy turned off",
  trigger_unknown: "unknown trigger \"{trigger}\"",
  watch_paths_invalid: "a pattern is not a valid Tugra watch-path glob — none carried",
  limits_invalid: "CPU/memory limits are outside Tugra's accepted range — none carried",
  command_compose: "a compose app declares its command in its compose file",
  command_invalid: "the command/args are not valid for Tugra's exec-form override",
  dockerfile_not_build: "inline Dockerfile applies only to Dockerfile builds",
  dockerfile_too_large: "the Dockerfile is larger than 48 KiB",
  dockerfile_nul: "Dockerfile must not contain a NUL byte",
  dockerfile_not_from: "the first instruction of the Dockerfile must be FROM (only ARG may precede it)",
  dockerfile_no_from: "the Dockerfile has no FROM instruction",
  dockerfile_invalid: "the Dockerfile text is not valid",
  dockerfile_rejected: "Tugra would not accept the Dockerfile text",
  build_target_invalid: "the build target is not a valid Dockerfile stage name",
  build_target_not_dockerfile: "a build target applies only to Dockerfile builds",
  labels_compose: "compose apps declare labels in the compose file",
  access_control_dropped: "an access-control middleware label (basic auth / IP allow-list / forward auth) was not carried; the imported app is not gated by it until you recreate it with Tugra basic auth or IP rules, before the first deploy",
  context_path: "Tugra has no separate docker build context (base directory only)",
  static_spa: "Tugra's static builds always serve an SPA fallback",
  replicas: "replicas convert the app to a swarm service — set the replica count explicitly in Tugra after import",
  domain_dns01: "uses a DNS-01 certificate. Tugra imports it as HTTP-01; enable per-host DNS-01 on the app (Domain options) after binding a DNS credential to the server",
  domain_custom_cert: "uses an uploaded certificate — upload it in Tugra (the certificate itself is not carried yet)",
  domain_no_https: "was served without HTTPS — Tugra serves custom domains over HTTPS (Let's Encrypt) and will upgrade it",
  domain_redirect: "redirects to {to} — configure the redirect in Tugra",
  domain_service_not_compose: "targets a named service, but this is not a compose app — Tugra routes the single app container",
  domain_path_invalid: "the path is not a valid Tugra path prefix — served at the host root",
  domain_dup_route: "same host with a different path/port/service — Tugra serves one route per host",
  domain_host_invalid: "not a hostname Tugra can serve",
  domain_alias: "is the www/bare counterpart of the primary domain — Tugra already serves it there",
  domain_service_no_port: "no routing port on the source — add this service domain in Tugra",
  domain_service_path: "per-service domains have no path routing in Tugra — add it manually",
  domain_service_name_invalid: "not a valid compose service name",
  domain_service_limit: "Tugra allows at most {max} service domains",
  domain_port_differs: "routes to container port {port}, but Tugra serves one container port per app ({primaryPort})",
  domain_path_differs: "uses a different path than the primary domain — Tugra's path prefix is app-wide",
  domain_extra_limit: "Tugra allows at most {max} extra domains",
  domain_primary_service: "bound to compose service \"{service}\" — Tugra routes the primary domain to the web service it infers from the compose file; verify it",
  ports_compose: "a compose app declares its published ports in its compose file",
  port_is_ingress: "container port {port} is the HTTP ingress port, already served through the proxy — publish it on the host manually if it is needed",
  port_duplicate: "host port + protocol already published by another mapping",
  ports_limit: "Tugra allows at most {max} extra published ports",
  redirects_invalid: "some redirect rules are not valid in Tugra (single-line regex/replacement, max 1024 chars) — re-create them manually",
  redirects_limit: "Tugra allows at most {max} redirect rules",
  setting_rejected: "Tugra rejected the setting — set it manually",
  inline_dockerfile_rejected: "Tugra rejected the setting. Set it manually",
  extras_read_failed: "could not read this app's labels or Dockerfile from the source; set them manually",
  labels_unparsable: "the label block could not be parsed",
  ingress_uninterpretable: "the source ingress could not be interpreted — configure domains and ports manually",
  basic_auth_not_carried: "basic-auth not carried — re-protect the app before cutover",
  basic_auth_users_dropped: "some basic-auth users could not be stored in Tugra — re-add them before cutover",
  custom_labels_deferred: "read when you apply: Tugra-safe labels are carried; reserved ones (traefik.*, tugra.*, com.docker.*) cannot be and are named in the import timeline",
  dockerfile_deferred: "read when you apply and set as the app's inline Dockerfile",
  coolify_basic_auth: "the source gated this app with HTTP basic auth; the credentials are not read, so the imported app is NOT gated until you set basic auth in Tugra before the first deploy",
  coolify_published_ports: "host-published ports are not carried; add them in the app's Ports settings",
  coolify_docker_options: "custom Docker run options are owner-gated in Tugra and never auto-applied",
  coolify_deploy_hooks: "set them in the app's Deploy hooks after import",
  coolify_limits: "resource limits are not carried from Coolify yet; set them in Tugra",
  coolify_healthcheck: "health check not carried",
  coolify_build_target: "build target not carried from Coolify yet",
  coolify_watch_paths: "watch paths not carried from Coolify yet",
  coolify_redirect: "the source redirects to the {mode} host name; Tugra serves both names without a redirect — add a redirect rule in Tugra if the canonical name matters",
  coolify_redis_conf: "the source Redis uses a custom redis.conf, which Tugra does not carry; re-apply its settings by hand after the import",
  coolify_inline_dockerfile: "an inline-Dockerfile app has no git repository; Tugra builds Dockerfile apps from a repo, so this app cannot be imported yet (repo-less Dockerfile apps are a planned feature)",
  dokploy_registry: "the registry credential is not carried; add the registry in Tugra before deploying a private image",
  dokploy_build_secrets: "build secret values are not read; re-add them as Tugra build secrets",
  dokploy_swarm_labels: "Dokploy Swarm service labels are not carried (Tugra custom labels are container labels)",
  dokploy_domains: "preview or disabled domains are not carried",
};

/** A reason by code: the English fallback text rendered from its params, the code and the params themselves. */
export function why(code: ImportReasonCode, params?: ReasonParams): Reasoned {
  const reason = REASON_EN[code].replace(/\{(\w+)\}/g, (m, k: string) => (params && k in params ? String(params[k]) : m));
  return { reason, reasonCode: code, ...(params && Object.keys(params).length ? { reasonParams: params } : {}) };
}
