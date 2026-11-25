import type { AgentReadMeta, PlanTeam } from "@tugra/shared";
import type { AgentRead, Row } from "../../coolify-takeover/coolify-agent-read";
import { APP_TEXT_PRESENT, DB_TEXT_PRESENT } from "../../coolify-takeover/coolify-agent-sql";

/**
 * Coolify database rows (the agent read) to the JSON Coolify's own REST API would have answered, path by path. The importer's
 * `CoolifySource` already turns that API shape into the neutral fleet, so the agent path yields the SAME plan shape as the token
 * path by construction: this file only has to be a faithful, secret-free stand-in for the API.
 *
 * Rules:
 *  - Nothing here sees a secret. A secret column arrives as `<column>_present`; a free-form text column that can hold one (compose
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

export interface AgentView {
  /** The API answer for a path. Throws {@link AgentApiNotFound} (`404 <path>`) for a path the agent read does not serve. */
  route(path: string): unknown;
  /** The Coolify version token read from the image tag (`4.0.0-beta.463`), or null. */
  versionText(): string | null;
  meta: AgentReadMeta;
  teams: PlanTeam[];
  /** Plain-language notes for the plan (a section this version lacks, a section read only up to its cap). */
  warnings: string[];
}

export function buildAgentView(read: AgentRead, agentServerId: string): AgentView {
  const rows = (name: string): Row[] => [...(read.sections.get(name) ?? [])].sort(byId);

  // ── servers ───────────────────────────────────────────────────────────────────────────────────────
  const servers = rows("servers");
  const serverUuid = new Map<string, string>();
  for (const s of servers) if (typeof s.uuid === "string") serverUuid.set(key(s.id), s.uuid);
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
    return { row: out, id: key(s.id), uuid, server };
  });
  const memberApps = (serviceId: string) =>
    serviceApps.filter((m) => key(m.service_id) === serviceId).map((m) => ({ uuid: m.uuid, name: m.name, fqdn: m.fqdn ?? null, image: m.image ?? null, ...(m.is_removed_from_compose === true ? { is_removed_from_compose: true } : {}) }));
  const memberDbs = (serviceId: string) =>
    serviceDbs.filter((m) => key(m.service_id) === serviceId).map((m) => ({ uuid: m.uuid, name: m.name, image: m.image ?? null, ...(m.is_removed_from_compose === true ? { is_removed_from_compose: true } : {}) }));

  // ── projects, environments, teams ────────────────────────────────────────────────────────────────
  const teamRows = rows("teams");
  const teamName = new Map<string, string>();
  for (const t of teamRows) teamName.set(key(t.id), str(t.name) ?? `Team ${key(t.id)}`);
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

  const route = (rawPath: string): unknown => {
    const path = rawPath.split("?")[0];
    const parts = path.split("/").filter(Boolean).map((x) => decodeURIComponent(x));
    const [a, b, c] = parts;
    const miss = () => new AgentApiNotFound(rawPath);

    if (parts.length === 1) {
      if (a === "servers") return servers.map(serverRow);
      if (a === "applications") return apps.map((x) => x.row);
      if (a === "databases") return dbs.map((x) => x.row);
      if (a === "services") return services.map((x) => x.row);
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
      if (parts.length === 2) return app.row;
      if (parts.length === 3 && c === "envs") return (envsOf.get(`application:${app.id}`) ?? []).map(envRow);
      if (parts.length === 3 && c === "storages") return { persistent_storages: (volumesOf.get(`application:${app.id}`) ?? []).map(volumeRow), file_storages: (fileVolumesOf.get(`application:${app.id}`) ?? []).map(fileVolumeRow) };
    }
    if (a === "databases" && b) {
      const db = byUuid(dbs, b);
      if (!db) throw miss();
      if (parts.length === 2) return db.row;
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
      if (parts.length === 2) return { ...svc.row, applications: memberApps(svc.id), databases: memberDbs(svc.id) };
      // A service's variables and its config files carry values (sealed pipeline, lane B): not served by this read.
    }
    if (a === "projects" && b && parts.length === 2) {
      const p = projects.find((x) => x.uuid === b);
      if (p) return projectDetail(p);
    }
    throw miss();
  };

  // ── plan additions ───────────────────────────────────────────────────────────────────────────────
  const teamsInPlan = new Map<string, string>();
  for (const p of projects) {
    const tid = key(p.team_id);
    if (tid && teamName.has(tid) && (envsByProject.get(key(p.id)) ?? []).length > 0) teamsInPlan.set(tid, teamName.get(tid)!);
  }
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

  return { route, versionText: () => imageVersion(read.image), meta, teams, warnings };
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
