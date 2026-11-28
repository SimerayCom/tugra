import type { AgentReadMeta, PlanTeam } from "@tugra/shared";
import type { AgentRead, Row } from "../../coolify-takeover/coolify-agent-read";
import { APP_TEXT_PRESENT, DB_TEXT_PRESENT } from "../../coolify-takeover/coolify-agent-sql";
import { NO_OVERLAY, type SecretOverlay, type SecretRefPlan } from "./agent-secrets";

/**
 * Coolify database rows (the agent read) to the JSON Coolify's own REST API would have answered, path by path. The importer's
 * `CoolifySource` already turns that API shape into the neutral fleet, so the agent path yields the SAME plan shape as the token
 * path by construction: this file only has to be a faithful, secret-free stand-in for the API.
 *
 * Rules:
 *  - Without an overlay nothing here sees a secret. A secret column arrives as `<column>_present`; a free-form text column that can hold one (compose
 *    text, Dockerfile, labels, custom Docker options, deploy hooks, engine config) is replaced by a `presence` map on the row and
 *    its key is left out, exactly like a read token without `read:sensitive` sees it. A text column that is present but empty is
 *    `null`, like the API's "visible but empty".
 *  - An env row has no value. Whether a value is a shared-variable reference cannot be known without decrypting it, so
 *    `is_shared` is never set here (the sealed pipeline, lane B, resolves values and references together).
 *  - Soft-deleted rows never arrive (the SQL filters them).
 */

const num = (v: unknown): number => (typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : Number.MAX_SAFE_INTEGER);
const byId = (a: Row, b: Row): number => num(a.id) - num(b.id);
const key = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const kindOf = (t: unknown): string => (typeof t === "string" ? (t.split("\\").pop() ?? "") : "").toLowerCase();
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** `sensitiveRoute` answers "not mine" with this, and the plain routes then decide. */
const MISS = Symbol("miss");

export class AgentApiNotFound extends Error {
  readonly status = 404;
  constructor(path: string) {
    super(`404 ${path}`);
  }
}

const DB_SECTIONS = ["postgresql", "mysql", "mariadb", "mongodb", "redis", "keydb", "dragonfly", "clickhouse"] as const;
const DB_MODEL: Record<(typeof DB_SECTIONS)[number], string> = {
  postgresql: "standalonepostgresql",
  mysql: "standalonemysql",
  mariadb: "standalonemariadb",
  mongodb: "standalonemongodb",
  redis: "standaloneredis",
  keydb: "standalonekeydb",
  dragonfly: "standalonedragonfly",
  clickhouse: "standaloneclickhouse",
};

/** Copy a row without its `_present` flags; text columns held back become a `presence` map (true) or a `null` key (empty). */
function withPresence(r: Row, textColumns: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) if (!k.endsWith("_present")) out[k] = v;
  const presence: Record<string, true> = {};
  for (const c of textColumns) {
    const flag = r[`${c}_present`];
    if (flag === true) presence[c] = true;
    else if (flag === false) out[c] = null;
  }
  if (Object.keys(presence).length) out.presence = presence;
  return out;
}

/** The text columns the sealed pipeline carries (the others stay presence flags). */
const APP_SEALED_TEXT = ["docker_compose_raw", "dockerfile", "custom_labels"] as const;
const DB_CONF_TEXT = ["postgres_conf", "mysql_conf", "mariadb_conf", "mongo_conf", "redis_conf", "keydb_conf", "dragonfly_conf"] as const;

/** Put opened text back into a row built by `withPresence`: the column returns and its presence mark goes. A value that is not there keeps its mark. */
function withText(row: Record<string, unknown>, overlay: SecretOverlay, ref: string, columns: readonly string[]): Record<string, unknown> {
  const presence = row.presence as Record<string, true> | undefined;
  if (!presence) return row;
  const out: Record<string, unknown> = { ...row };
  const left: Record<string, true> = { ...presence };
  for (const c of columns) {
    if (!left[c]) continue;
    const v = overlay.get(ref, c);
    if (v === undefined) continue;
    out[c] = v;
    delete left[c];
  }
  if (Object.keys(left).length) out.presence = left;
  else delete out.presence;
  return out;
}

/** The notification channels of Coolify and the secret columns of each (the sealed class `notification`). */
const NOTIFY_KINDS = { email: "notify_email", discord: "notify_discord", telegram: "notify_telegram", slack: "notify_slack", pushover: "notify_pushover", webhook: "notify_webhook" } as const;
const NOTIFY_SECRET_FIELDS = ["smtp_password", "resend_api_key", "discord_webhook_url", "slack_webhook_url", "telegram_token", "pushover_user_key", "pushover_api_token", "webhook_url"] as const;
const SHARED_REF_RE = /\{\{\s*(team|project|environment)\.([A-Za-z0-9_.-]{1,128})\s*\}\}/g;
const REF_RE = /^[a-z0-9_]{1,20}:[A-Za-z0-9_-]{1,64}$/;

export interface AgentViewOptions {
  /** The Coolify team whose settings (notifications, shared variables, tags, members, S3) the settings routes answer. Default: the only team that has projects. */
  teamRef?: string;
}

export interface AgentView {
  /**
   * The API answer for a path. Throws {@link AgentApiNotFound} (`404 <path>`) for a path the agent read does not serve.
   * `overlay` gives back opened text (compose text); `sensitive` also serves the paths that carry values (env values, service
   * variables and files, tasks, notifications, shared variables): the answer of a token that may read sensitive fields.
   */
  route(path: string, overlay?: SecretOverlay, sensitive?: boolean): unknown;
  /** The `kind:id` refs of the secrets this Coolify holds, per consent class: what the sealed read has to ask for. */
  secretRefs(): SecretRefPlan;
  /**
   * The refs the PLAN needs sealed text for, and nothing else: the compose text of compose-based apps and of services (the plan reads
   * `docker_compose_raw` only). No Dockerfile-only or labels-only app, no config-file content, no variable, no database setting.
   * `stacks` narrows it to the services with these uuids (and drops the apps): the service preview asks for the stacks in scope only.
   */
  planRefs(stacks?: ReadonlySet<string> | null): SecretRefPlan;
  /**
   * What is known without reading a value: a variable or a config file that HAS content answers with an empty string, one that has none
   * answers nothing. The names-only preview of a service stack is built from this, so it needs no sealed read of any value.
   */
  presence(): SecretOverlay;
  /** The Coolify team the settings routes answer for, or null when there are several and none was chosen. */
  currentTeam: { ref: string; name: string } | null;
  /** Several Coolify teams have projects and none was chosen: the settings of the team cannot be told apart. */
  needsTeamChoice: boolean;
  /** The Coolify version token read from the image tag (`4.0.0-beta.463`), or null. */
  versionText(): string | null;
  meta: AgentReadMeta;
  teams: PlanTeam[];
  /** Plain-language notes for the plan (a section this version lacks, a section read only up to its cap). */
  warnings: string[];
}

export function buildAgentView(read: AgentRead, agentServerId: string, opts: AgentViewOptions = {}): AgentView {
  const rows = (name: string): Row[] => [...(read.sections.get(name) ?? [])].sort(byId);

  // ── servers ───────────────────────────────────────────────────────────────────────────────────────
  const servers = rows("servers");
  const serverUuid = new Map<string, string>();
  for (const s of servers) if (typeof s.uuid === "string") serverUuid.set(key(s.id), s.uuid);
  // set once the teams are read (a few lines below); serverRow only runs later, from the routes
  let teamOfRow: (id: unknown) => { id: string; name: string } | undefined = () => undefined;
  const serverRow = (s: Row): Record<string, unknown> => {
    const meta = osMeta(s.server_metadata);
    return {
      uuid: s.uuid,
      name: s.name,
      description: s.description ?? null,
      ip: s.ip,
      port: s.port,
      user: s.user,
      // Coolify's own box is the row with id 0 (its API name for it is `localhost`).
      is_coolify_host: key(s.id) === "0",
      ...(typeof s.unreachable_count === "number" ? { unreachable_count: s.unreachable_count } : {}),
      ...(meta ? { server_metadata: meta } : {}),
      // The Coolify team the server belongs to (this read sees every team): lets the wizard show only the picked team's servers.
      ...(teamOfRow(s.team_id) ? { team: teamOfRow(s.team_id) } : {}),
    };
  };

  // ── destinations: where a resource runs ──────────────────────────────────────────────────────────
  const destServer = new Map<string, string>();
  for (const [section, model] of [["docker_standalone", "standalonedocker"], ["docker_swarm", "swarmdocker"]] as const) {
    for (const d of rows(section)) if (d.id !== undefined && d.server_id !== undefined) destServer.set(`${model}:${key(d.id)}`, key(d.server_id));
  }
  const serverOfDestination = (type: unknown, id: unknown): string | undefined => {
    const sid = destServer.get(`${kindOf(type)}:${key(id)}`);
    return sid ? serverUuid.get(sid) : undefined;
  };

  // ── per-resource side tables ─────────────────────────────────────────────────────────────────────
  const settingsOf = new Map<string, Row>();
  for (const s of rows("app_settings")) settingsOf.set(key(s.application_id), s);

  const envsOf = new Map<string, Row[]>();
  for (const e of rows("env_vars")) {
    const k = `${kindOf(e.resourceable_type)}:${key(e.resourceable_id)}`;
    envsOf.set(k, [...(envsOf.get(k) ?? []), e]);
  }
  const volumesOf = new Map<string, Row[]>();
  for (const v of rows("volumes")) {
    const k = `${kindOf(v.resource_type)}:${key(v.resource_id)}`;
    volumesOf.set(k, [...(volumesOf.get(k) ?? []), v]);
  }
  const fileVolumesOf = new Map<string, Row[]>();
  for (const v of rows("file_volumes")) {
    const k = `${kindOf(v.resource_type)}:${key(v.resource_id)}`;
    fileVolumesOf.set(k, [...(fileVolumesOf.get(k) ?? []), v]);
  }

  // ── applications ─────────────────────────────────────────────────────────────────────────────────
  const apps = rows("applications").map((a) => {
    const out = withPresence(a, APP_TEXT_PRESENT);
    const st = settingsOf.get(key(a.id));
    if (st) {
      const settings: Record<string, unknown> = {};
      for (const k of ["is_static", "is_spa", "custom_container_name_prefix"]) if (k in st) settings[k] = st[k];
      out.settings = settings;
    }
    return { row: out, id: key(a.id), uuid: str(a.uuid) ?? "", server: serverOfDestination(a.destination_type, a.destination_id), source: a };
  });

  // ── databases ────────────────────────────────────────────────────────────────────────────────────
  const dbs = DB_SECTIONS.flatMap((type) =>
    rows(`db_${type}`).map((d) => {
      const out = withPresence(d, DB_TEXT_PRESENT);
      delete out.type; // the section's constant, replaced by the API's own name for it
      out.database_type = `standalone-${type}`;
      return { row: out, id: key(d.id), uuid: str(d.uuid) ?? "", model: DB_MODEL[type], server: serverOfDestination(d.destination_type, d.destination_id), source: d };
    }),
  );

  // ── services ─────────────────────────────────────────────────────────────────────────────────────
  const serviceApps = rows("service_apps");
  const serviceDbs = rows("service_dbs");
  const services = rows("services").map((s) => {
    const out = withPresence(s, ["docker_compose_raw", "docker_compose"]);
    delete out.server_id;
    const uuid = str(s.uuid) ?? "";
    const server = s.server_id !== undefined && s.server_id !== null ? serverUuid.get(key(s.server_id)) : serverOfDestination(s.destination_type, s.destination_id);
    return { row: out, id: key(s.id), uuid, server, environmentId: s.environment_id };
  });
  const memberApps = (serviceId: string) =>
    serviceApps.filter((m) => key(m.service_id) === serviceId).map((m) => ({ uuid: m.uuid, name: m.name, fqdn: m.fqdn ?? null, image: m.image ?? null, ...(m.is_removed_from_compose === true ? { is_removed_from_compose: true } : {}) }));
  const memberDbs = (serviceId: string) =>
    serviceDbs.filter((m) => key(m.service_id) === serviceId).map((m) => ({ uuid: m.uuid, name: m.name, image: m.image ?? null, ...(m.is_removed_from_compose === true ? { is_removed_from_compose: true } : {}) }));

  // ── projects, environments, teams ────────────────────────────────────────────────────────────────
  const teamRows = rows("teams");
  const teamName = new Map<string, string>();
  for (const t of teamRows) teamName.set(key(t.id), str(t.name) ?? `Team ${key(t.id)}`);
  teamOfRow = (id) => {
    const tid = key(id);
    return tid && teamName.has(tid) ? { id: tid, name: teamName.get(tid)! } : undefined;
  };
  const projects = rows("projects");
  const envsByProject = new Map<string, Row[]>();
  for (const e of rows("environments")) envsByProject.set(key(e.project_id), [...(envsByProject.get(key(e.project_id)) ?? []), e]);
  const projectDetail = (p: Row): Record<string, unknown> => {
    const tid = key(p.team_id);
    return {
      uuid: p.uuid,
      name: p.name,
      description: p.description ?? null,
      environments: (envsByProject.get(key(p.id)) ?? []).map((e) => ({ id: e.id, name: e.name, project_id: e.project_id, ...(typeof e.uuid === "string" ? { uuid: e.uuid } : {}) })),
      ...(tid && teamName.has(tid) ? { team: { id: tid, name: teamName.get(tid) } } : {}),
    };
  };

  // ── backups and S3 ───────────────────────────────────────────────────────────────────────────────
  const s3 = rows("s3");
  const s3UuidById = new Map<string, string>();
  for (const x of s3) if (typeof x.uuid === "string") s3UuidById.set(key(x.id), x.uuid);
  const backups = rows("backups");
  const s3Row = (x: Row): Record<string, unknown> => ({
    id: x.id,
    uuid: x.uuid,
    name: x.name,
    type: typeof x.type === "string" ? x.type : "s3",
    endpoint: x.endpoint ?? null,
    bucket: x.bucket ?? null,
    region: x.region ?? null,
    ...(x.use_path_style_endpoint === true ? { use_path_style_endpoint: true } : {}),
  });

  // ── settings sources (the settings routes: one Coolify team) ──────────────────────────────────────
  const teamsInPlan = new Map<string, string>();
  for (const p of projects) {
    const tid = key(p.team_id);
    if (tid && teamName.has(tid) && (envsByProject.get(key(p.id)) ?? []).length > 0) teamsInPlan.set(tid, teamName.get(tid)!);
  }
  let currentTeamId: string | undefined = opts.teamRef && teamName.has(opts.teamRef) ? opts.teamRef : undefined;
  if (!currentTeamId && teamsInPlan.size === 1) currentTeamId = [...teamsInPlan.keys()][0];
  const currentTeam = currentTeamId ? { ref: currentTeamId, name: teamName.get(currentTeamId)! } : null;
  const needsTeamChoice = !currentTeamId && teamsInPlan.size > 1;

  const sharedRows = rows("shared_vars");
  const sharedUuid = new Map<string, string>(); // `${type}:${scopeId}:${key}` -> row uuid
  for (const v of sharedRows) {
    const scopeId = v.type === "team" ? key(v.team_id) : v.type === "project" ? key(v.project_id) : v.type === "environment" ? key(v.environment_id) : "";
    if (typeof v.uuid === "string" && typeof v.key === "string" && scopeId) sharedUuid.set(`${String(v.type)}:${scopeId}:${v.key}`, v.uuid);
  }
  const projectOfEnvironment = new Map<string, string>();
  const environmentName = new Map<string, string>();
  for (const e of rows("environments")) {
    projectOfEnvironment.set(key(e.id), key(e.project_id));
    environmentName.set(key(e.id), str(e.name) ?? "");
  }
  const teamOfProject = new Map<string, string>();
  for (const p of projects) teamOfProject.set(key(p.id), key(p.team_id));
  /** `{{team.X}}` / `{{project.X}}` / `{{environment.X}}` written into a value, as Coolify expands them; undefined when one cannot be resolved. */
  const expandShared = (value: string, environmentId: unknown, overlay: SecretOverlay): string | undefined => {
    if (!value.includes("{{")) return undefined;
    const projectId = projectOfEnvironment.get(key(environmentId)) ?? "";
    const scopeOf: Record<string, string> = { team: teamOfProject.get(projectId) ?? "", project: projectId, environment: key(environmentId) };
    let all = true;
    const out = value.replace(SHARED_REF_RE, (whole, scope: string, name: string) => {
      const uuid = scopeOf[scope] ? sharedUuid.get(`${scope}:${scopeOf[scope]}:${name}`) : undefined;
      const v = uuid ? overlay.get(`shared_env:${uuid}`, "value") : undefined;
      if (v === undefined) {
        all = false;
        return whole;
      }
      return v;
    });
    return all ? out : undefined;
  };
  const sharedApiRows = (type: "team" | "project" | "environment", scopeId: string, overlay: SecretOverlay): Array<Record<string, unknown>> =>
    sharedRows
      .filter((v) => v.type === type && key(type === "team" ? v.team_id : type === "project" ? v.project_id : v.environment_id) === scopeId)
      .map((v) => {
        const ref = typeof v.uuid === "string" ? `shared_env:${v.uuid}` : "";
        const value = ref ? overlay.get(ref, "value") : undefined;
        return { key: v.key, is_preview: false, is_shown_once: v.is_shown_once === true, is_multiline: v.is_multiline === true, is_literal: v.is_literal === true, ...(value !== undefined ? { value } : {}) };
      });

  const tags = rows("tags").filter((t) => currentTeamId !== undefined && key(t.team_id) === currentTeamId);
  const tagName = new Map<string, string>();
  for (const t of rows("tags")) if (typeof t.name === "string") tagName.set(key(t.id), t.name);
  const tagsOfResource = (model: string, id: string): Array<{ name: string }> =>
    rows("taggables")
      .filter((x) => kindOf(x.taggable_type) === model && key(x.taggable_id) === id && tagName.has(key(x.tag_id)))
      .map((x) => ({ name: tagName.get(key(x.tag_id))! }));
  const userById = new Map<string, Row>();
  for (const u of rows("users")) userById.set(key(u.id), u);
  const members = rows("team_members")
    .filter((m) => currentTeamId !== undefined && key(m.team_id) === currentTeamId)
    .flatMap((m) => {
      const u = userById.get(key(m.user_id));
      return u && typeof u.email === "string" ? [{ email: u.email, name: u.name ?? u.email, role: m.role ?? null }] : [];
    });
  const serverSettingsOf = new Map<string, Row>();
  for (const x of rows("server_settings")) serverSettingsOf.set(key(x.server_id), x);

  // ── what runs on which server ────────────────────────────────────────────────────────────────────
  const resourcesOf = (serverUuidWanted: string): Array<{ uuid: string; type: string }> => [
    ...apps.filter((a) => a.server === serverUuidWanted && a.uuid).map((a) => ({ uuid: a.uuid, type: "application" })),
    ...dbs.filter((d) => d.server === serverUuidWanted && d.uuid).map((d) => ({ uuid: d.uuid, type: "database" })),
    ...services.filter((s) => s.server === serverUuidWanted && s.uuid).map((s) => ({ uuid: s.uuid, type: "service" })),
  ];

  const envRow = (e: Row): Record<string, unknown> => ({
    key: e.key,
    ...(typeof (e.is_buildtime ?? e.is_build_time) === "boolean" ? { is_buildtime: e.is_buildtime ?? e.is_build_time } : {}),
    ...(typeof e.is_runtime === "boolean" ? { is_runtime: e.is_runtime } : {}),
    ...(typeof e.is_literal === "boolean" ? { is_literal: e.is_literal } : {}),
    ...(typeof e.is_multiline === "boolean" ? { is_multiline: e.is_multiline } : {}),
    ...(typeof e.is_shown_once === "boolean" ? { is_shown_once: e.is_shown_once } : {}),
    ...(typeof e.is_coolify === "boolean" ? { is_coolify: e.is_coolify } : {}),
    is_preview: e.is_preview === true,
  });
  const volumeRow = (v: Row): Record<string, unknown> => ({ name: v.name ?? null, mount_path: v.mount_path ?? null, host_path: v.host_path ?? null });
  const fileVolumeRow = (v: Row): Record<string, unknown> => ({ fs_path: v.fs_path ?? null, mount_path: v.mount_path ?? null, is_directory: v.is_directory === true });

  const byUuid = <T extends { uuid: string }>(list: T[], u: string): T | undefined => list.find((x) => x.uuid === u);

  // ── the paths that carry values (sensitive mode only) ────────────────────────────────────────────
  const envRowWithValue = (e: Row, environmentId: unknown, overlay: SecretOverlay): Record<string, unknown> => {
    const base = envRow(e);
    const ref = typeof e.uuid === "string" ? `env:${e.uuid}` : "";
    const v = ref ? overlay.get(ref, "value") : undefined;
    if (v !== undefined) {
      const real = e.is_literal === true ? undefined : expandShared(v, environmentId, overlay);
      return { ...base, value: v, ...(real !== undefined && real !== v ? { real_value: real } : {}) };
    }
    // Nothing is stored (NULL or empty) and the row is not locked: the variable is simply empty. A locked or unreadable one stays without a value.
    if (e.value_present === false && e.is_shown_once !== true) return { ...base, value: "" };
    return base;
  };
  const kindOfNotification = (v: string): keyof typeof NOTIFY_KINDS | undefined => (Object.prototype.hasOwnProperty.call(NOTIFY_KINDS, v) ? (v as keyof typeof NOTIFY_KINDS) : undefined);

  const sensitiveRoute = (parts: string[], overlay: SecretOverlay): unknown => {
    const [a, b, c, d, f] = parts;
    const miss = new AgentApiNotFound(`/${parts.join("/")}`);
    if (a === "teams" && b === "current" && parts.length === 2) {
      if (!currentTeam) throw miss;
      return { id: currentTeam.ref, name: currentTeam.name };
    }
    if (a === "team" && b === "envs" && parts.length === 2) {
      if (!currentTeamId) throw miss;
      return sharedApiRows("team", currentTeamId, overlay);
    }
    if (a === "team" && b === "members" && parts.length === 2) {
      if (!currentTeamId) throw miss;
      return members;
    }
    // The settings readers list resources to ask each one for its tasks and tags: only the chosen team's own (a Coolify token sees one team).
    if (parts.length === 1 && (a === "applications" || a === "databases" || a === "services" || a === "servers" || a === "projects")) {
      if (!currentTeamId) throw miss;
      const mine = (environmentId: unknown): boolean => teamOfProject.get(projectOfEnvironment.get(key(environmentId)) ?? "") === currentTeamId;
      if (a === "applications") return apps.filter((x) => mine(x.source.environment_id)).map((x) => withText(x.row, overlay, `application:${x.uuid}`, APP_SEALED_TEXT));
      if (a === "databases") return dbs.filter((x) => mine(x.source.environment_id)).map((x) => withText(x.row, overlay, `database:${x.uuid}`, DB_CONF_TEXT));
      if (a === "services") return services.filter((x) => mine(x.environmentId)).map((x) => withText(x.row, overlay, `service:${x.uuid}`, ["docker_compose_raw"]));
      if (a === "servers") return servers.filter((x) => key(x.team_id) === currentTeamId).map(serverRow);
      return projects.filter((x) => key(x.team_id) === currentTeamId).map((x) => ({ uuid: x.uuid, name: x.name, description: x.description ?? null }));
    }
    if (a === "tags" && parts.length === 1) {
      if (!currentTeamId) throw miss;
      return tags.map((t) => ({ name: t.name }));
    }
    if (a === "s3-storages" && parts.length === 1) {
      return s3.filter((x) => currentTeamId === undefined || key(x.team_id) === currentTeamId).map(s3Row);
    }
    if (a === "notifications" && parts.length === 2) {
      const kind = kindOfNotification(b);
      if (!kind || !currentTeamId) throw miss;
      const row = rows(NOTIFY_KINDS[kind]).find((x) => key(x.team_id) === currentTeamId);
      if (!row) throw miss;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row)) if (!k.endsWith("_present")) out[k] = v;
      for (const field of NOTIFY_SECRET_FIELDS) {
        const v = overlay.get(`notification:${currentTeamId}`, field);
        if (v !== undefined) out[field] = v;
      }
      return out;
    }
    if (a === "projects" && b) {
      const p = projects.find((x) => x.uuid === b);
      if (!p) throw miss;
      if (c === "envs" && parts.length === 3) return sharedApiRows("project", key(p.id), overlay);
      if (c === "environments" && d && f === "envs" && parts.length === 5) {
        const env = (envsByProject.get(key(p.id)) ?? []).find((e) => e.name === d);
        if (!env) throw miss;
        return sharedApiRows("environment", key(env.id), overlay);
      }
    }
    if (a === "servers" && b && c === "docker-cleanup" && parts.length === 3) {
      const srv = servers.find((x) => x.uuid === b);
      const st = srv ? serverSettingsOf.get(key(srv.id)) : undefined;
      if (!st || typeof st.docker_cleanup_frequency !== "string") throw miss;
      return {
        docker_cleanup_frequency: st.docker_cleanup_frequency,
        ...(typeof st.docker_cleanup_threshold === "number" ? { docker_cleanup_threshold: st.docker_cleanup_threshold } : {}),
        delete_unused_volumes: st.delete_unused_volumes === true,
        delete_unused_networks: st.delete_unused_networks === true,
        force_docker_cleanup: st.force_docker_cleanup === true,
      };
    }
    if ((a === "applications" || a === "services" || a === "databases") && b && parts.length === 3) {
      const res = a === "applications" ? byUuid(apps, b) : a === "services" ? byUuid(services, b) : byUuid(dbs, b);
      if (!res) throw miss;
      if (c === "tags") return tagsOfResource(a === "applications" ? "application" : a === "services" ? "service" : (res as (typeof dbs)[number]).model, res.id);
      if (c === "scheduled-tasks" && a !== "databases") {
        const col = a === "applications" ? "application_id" : "service_id";
        return rows("scheduled_tasks")
          .filter((t) => key(t[col]) === res.id)
          .map((t) => {
            const command = typeof t.uuid === "string" ? overlay.get(`scheduled_task:${t.uuid}`, "command") : undefined;
            return { uuid: t.uuid, name: t.name, frequency: t.frequency, container: t.container ?? null, timeout: t.timeout ?? null, enabled: t.enabled !== false, ...(command !== undefined ? { command } : {}) };
          });
      }
      if (c === "envs" && a === "applications") {
        const app = res as (typeof apps)[number];
        return (envsOf.get(`application:${app.id}`) ?? []).map((e) => envRowWithValue(e, app.source.environment_id, overlay));
      }
      if (c === "envs" && a === "services") {
        const svc = res as (typeof services)[number];
        const environmentId = rows("services").find((x) => key(x.id) === svc.id)?.environment_id;
        return (envsOf.get(`service:${svc.id}`) ?? []).map((e) => envRowWithValue(e, environmentId, overlay));
      }
      if (c === "storages" && a === "services") {
        const svc = res as (typeof services)[number];
        const files = (fileVolumesOf.get(`service:${svc.id}`) ?? []).map((v) => {
          const content = v.id !== undefined ? overlay.get(`file_volume:${key(v.id)}`, "content") : undefined;
          return { ...fileVolumeRow(v), ...(content !== undefined ? { content } : {}) };
        });
        return { persistent_storages: (volumesOf.get(`service:${svc.id}`) ?? []).map(volumeRow), file_storages: files };
      }
    }
    return MISS;
  };

  const route = (rawPath: string, overlay: SecretOverlay = NO_OVERLAY, sensitive = false): unknown => {
    const path = rawPath.split("?")[0];
    const parts = path.split("/").filter(Boolean).map((x) => decodeURIComponent(x));
    const [a, b, c] = parts;
    const miss = () => new AgentApiNotFound(rawPath);

    const appOut = (x: (typeof apps)[number]): Record<string, unknown> => withText(x.row, overlay, `application:${x.uuid}`, APP_SEALED_TEXT);
    const dbOut = (x: (typeof dbs)[number]): Record<string, unknown> => withText(x.row, overlay, `database:${x.uuid}`, DB_CONF_TEXT);
    const svcOut = (x: (typeof services)[number]): Record<string, unknown> => withText(x.row, overlay, `service:${x.uuid}`, ["docker_compose_raw"]);

    if (sensitive) {
      const answer = sensitiveRoute(parts, overlay);
      if (answer !== MISS) return answer;
    }

    if (parts.length === 1) {
      if (a === "servers") return servers.map(serverRow);
      if (a === "applications") return apps.map(appOut);
      if (a === "databases") return dbs.map(dbOut);
      if (a === "services") return services.map(svcOut);
      if (a === "projects") return projects.map((p) => ({ uuid: p.uuid, name: p.name, description: p.description ?? null }));
      if (a === "s3-storages") return s3.map((x) => ({ id: x.id, uuid: x.uuid, name: x.name }));
    }
    if (a === "servers" && b) {
      const s = servers.find((x) => x.uuid === b);
      if (!s) throw miss();
      if (parts.length === 2) return serverRow(s);
      if (parts.length === 3 && c === "resources") return resourcesOf(b);
    }
    if (a === "applications" && b) {
      const app = byUuid(apps, b);
      if (!app) throw miss();
      if (parts.length === 2) return appOut(app);
      if (parts.length === 3 && c === "envs") return (envsOf.get(`application:${app.id}`) ?? []).map(envRow);
      if (parts.length === 3 && c === "storages") return { persistent_storages: (volumesOf.get(`application:${app.id}`) ?? []).map(volumeRow), file_storages: (fileVolumesOf.get(`application:${app.id}`) ?? []).map(fileVolumeRow) };
    }
    if (a === "databases" && b) {
      const db = byUuid(dbs, b);
      if (!db) throw miss();
      if (parts.length === 2) return dbOut(db);
      if (parts.length === 3 && c === "storages") return { persistent_storages: (volumesOf.get(`${db.model}:${db.id}`) ?? []).map(volumeRow), file_storages: [] };
      if (parts.length === 3 && c === "backups") {
        return backups
          .filter((x) => kindOf(x.database_type) === db.model && key(x.database_id) === db.id)
          .map((x) => ({
            enabled: x.enabled,
            save_s3: x.save_s3,
            frequency: x.frequency,
            s3_storage_id: x.s3_storage_id ?? null,
            ...(s3UuidById.get(key(x.s3_storage_id)) ? { s3_storage_uuid: s3UuidById.get(key(x.s3_storage_id)) } : {}),
          }));
      }
    }
    if (a === "services" && b) {
      const svc = byUuid(services, b);
      if (!svc) throw miss();
      if (parts.length === 2) return { ...svcOut(svc), applications: memberApps(svc.id), databases: memberDbs(svc.id) };
      // A service's variables and its config files carry values (sealed pipeline, lane B): not served by this read.
    }
    if (a === "projects" && b && parts.length === 2) {
      const p = projects.find((x) => x.uuid === b);
      if (p) return projectDetail(p);
    }
    throw miss();
  };

  // ── plan additions ───────────────────────────────────────────────────────────────────────────────
  const teams: PlanTeam[] = [...teamsInPlan.entries()].map(([ref, name]) => ({ ref, name })).sort((x, y) => (x.name.toLowerCase() < y.name.toLowerCase() ? -1 : x.name.toLowerCase() > y.name.toLowerCase() ? 1 : x.ref < y.ref ? -1 : 1));

  const count = (name: string): number => (read.sections.get(name) ?? []).length;
  const present = (name: string, col: string): number => (read.sections.get(name) ?? []).filter((r) => r[`${col}_present`] === true).length;
  const dbCredentials = DB_SECTIONS.reduce((n, t) => n + (read.sections.get(`db_${t}`) ?? []).filter((r) => Object.entries(r).some(([k, v]) => /_password_present$/.test(k) && v === true)).length, 0);
  const secretCounts: Record<string, number> = {
    env: present("env_vars", "value"),
    shared_env: present("shared_vars", "value"),
    db_credentials: dbCredentials,
    basic_auth: present("applications", "http_basic_auth_password"),
    service_compose: present("services", "docker_compose_raw"),
    task_command: present("scheduled_tasks", "command"),
    s3: present("s3", "key") + present("s3", "secret"),
    deploy_key: present("private_keys", "private_key"),
  };
  const meta: AgentReadMeta = {
    transport: "agent",
    agentServerId,
    schemaVersion: read.schemaVersion,
    coolifyImage: read.image,
    readAt: read.readAt,
    counts: { teams: count("teams"), projects: count("projects"), servers: count("servers"), applications: apps.length, databases: dbs.length, services: services.length },
    secretCounts,
  };

  const warnings: string[] = [];
  if (read.truncated.length) warnings.push(`the Coolify read hit its row limit for ${read.truncated.join(", ")} - the plan may be incomplete`);
  for (const core of ["servers", "applications"]) if (read.skipped.includes(core)) warnings.push(`this Coolify version has no ${core} table - nothing of that kind was read`);

  /** The refs of every secret this Coolify holds, per consent class (only rows the read says have a value). */
  let presentSets: { env: Set<string>; files: Set<string> } | undefined;
  const presentRefs = (): { env: Set<string>; files: Set<string> } =>
    (presentSets ??= {
      env: new Set(rows("env_vars").filter((e) => e.is_preview !== true && e.value_present === true && typeof e.uuid === "string").map((e) => `env:${e.uuid}`)),
      files: new Set(rows("file_volumes").filter((v) => kindOf(v.resource_type) === "service" && v.content_present === true && v.id !== undefined).map((v) => `file_volume:${key(v.id)}`)),
    });
  const presenceOverlay: SecretOverlay = {
    get: (ref, field) => (field === "value" && presentRefs().env.has(ref)) || (field === "content" && presentRefs().files.has(ref)) ? "" : undefined,
  };

  /** The refs of the compose text the plan reads (see {@link AgentView.planRefs}). */
  const planRefs = (stacks?: ReadonlySet<string> | null): SecretRefPlan => {
    const uniq = (xs: string[]): string[] => [...new Set(xs.filter((r) => REF_RE.test(r)))];
    const apps = stacks ? [] : rows("applications").filter((a) => a.docker_compose_raw_present === true && typeof a.uuid === "string").map((a) => `application:${a.uuid}`);
    const svcs = rows("services").filter((x) => x.docker_compose_raw_present === true && typeof x.uuid === "string" && (!stacks || stacks.has(x.uuid))).map((x) => `service:${x.uuid}`);
    return { service_compose: uniq([...apps, ...svcs]) };
  };

  const secretRefs = (): SecretRefPlan => {
    const ok = (r: string): boolean => REF_RE.test(r);
    const uniq = (xs: string[]): string[] => [...new Set(xs.filter(ok))];
    const textApps = rows("applications").filter((a) => a.docker_compose_raw_present === true || a.dockerfile_present === true || a.custom_labels_present === true);
    const textServices = rows("services").filter((x) => x.docker_compose_raw_present === true);
    const withConf = dbs.filter((d) => DB_CONF_TEXT.some((c) => d.source[`${c}_present`] === true));
    return {
      env: uniq(rows("env_vars").filter((e) => e.is_preview !== true && e.value_present === true && typeof e.uuid === "string").map((e) => `env:${e.uuid}`)),
      shared_env: uniq(sharedRows.filter((v) => v.value_present === true && typeof v.uuid === "string").map((v) => `shared_env:${v.uuid}`)),
      service_compose: uniq([
        ...textApps.filter((a) => typeof a.uuid === "string").map((a) => `application:${a.uuid}`),
        ...textServices.filter((x) => typeof x.uuid === "string").map((x) => `service:${x.uuid}`),
        ...rows("file_volumes").filter((v) => kindOf(v.resource_type) === "service" && v.content_present === true && v.id !== undefined).map((v) => `file_volume:${key(v.id)}`),
      ]),
      db_credentials: uniq(withConf.filter((d) => d.uuid).map((d) => `database:${d.uuid}`)),
      task_command: uniq(rows("scheduled_tasks").filter((t) => t.command_present === true && typeof t.uuid === "string").map((t) => `scheduled_task:${t.uuid}`)),
      notification: currentTeamId ? uniq([`notification:${currentTeamId}`]) : [],
    };
  };

  return { route, secretRefs, planRefs, presence: () => presenceOverlay, currentTeam, needsTeamChoice, versionText: () => imageVersion(read.image), meta, teams, warnings };
}

/** The version token of an image reference (`ghcr.io/coollabsio/coolify:4.0.0-beta.463` -> `4.0.0-beta.463`). */
function imageVersion(image: string | null): string | null {
  if (!image || image.includes("@")) return null;
  const tag = image.split("/").pop()?.split(":")[1];
  return tag && /^v?\d{1,6}(\.\d{1,6}){1,2}([-+][0-9A-Za-z.+-]{0,40})?$/.test(tag) ? tag : null;
}

/** The OS text of a server's metadata (a JSON object or its text). Only the OS fields are kept. */
function osMeta(raw: unknown): { os?: string; os_release?: string; os_version?: string } | undefined {
  let v: unknown = raw;
  if (typeof raw === "string") {
    try {
      v = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const pick = (k: string): string | undefined => (typeof o[k] === "string" && o[k] ? (o[k] as string).slice(0, 80) : undefined);
  const out = { os: pick("os"), os_release: pick("os_release"), os_version: pick("os_version") };
  const clean = Object.fromEntries(Object.entries(out).filter(([, x]) => x !== undefined));
  return Object.keys(clean).length ? clean : undefined;
}
