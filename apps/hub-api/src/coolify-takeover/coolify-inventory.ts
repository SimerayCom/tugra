import { CFY } from "./coolify-read-script";
import { SECTIONS } from "./coolify-sql";

/**
 * Turn the read script's output into the stored inventory. Everything is picked field by field (nothing the agent sent
 * passes through unexamined), strings are bounded, secret-looking keys are dropped, and no value of a secret field exists
 * to begin with: the SQL reports those as `<column>_present` booleans only.
 */

export type CoolifyReadFailure = "no_docker" | "no_coolify" | "db_stopped" | "not_read_only" | "unreadable";

export class CoolifyReadError extends Error {
  constructor(readonly failure: CoolifyReadFailure) {
    super(failure);
  }
}

// ---- stored shape ---------------------------------------------------------------------------------------------------

export type Resource = { teamId: string | null; projectId: string | null; environment: string | null; serverId: string | null };

export interface InvTeam {
  id: string;
  name: string;
  description: string | null;
  personal: boolean;
  members: number;
  notifications: Array<{ channel: string; enabled: boolean; configured: boolean }>;
}
export interface InvServer {
  id: string;
  uuid: string;
  name: string;
  description: string | null;
  ip: string;
  port: number;
  user: string;
  teamId: string | null;
  /** The Coolify host itself (its built-in "localhost" server): this is the box the agent runs on. */
  isLocal: boolean;
  reachable: boolean | null;
  usable: boolean | null;
  buildServer: boolean;
  swarm: boolean;
  keyName: string | null;
  apps: number;
  databases: number;
  services: number;
}
export interface InvProject {
  id: string;
  uuid: string;
  name: string;
  description: string | null;
  teamId: string | null;
  environments: Array<{ id: string; uuid: string; name: string }>;
}
export interface InvApp extends Resource {
  id: string;
  uuid: string;
  name: string;
  fqdn: string | null;
  gitRepository: string | null;
  gitBranch: string | null;
  buildPack: string | null;
  image: string | null;
  status: string | null;
  envCount: number;
  previewEnvCount: number;
  hasCompose: boolean;
}
export interface InvDb extends Resource {
  id: string;
  uuid: string;
  name: string;
  type: string;
  image: string | null;
  status: string | null;
  isPublic: boolean;
}
export interface InvService extends Resource {
  id: string;
  uuid: string;
  name: string;
  kind: string | null;
  components: number;
  envCount: number;
}
export interface InvSharedVariable {
  scope: "team" | "project" | "environment";
  teamId: string | null;
  projectId: string | null;
  environment: string | null;
  key: string;
}
export interface InvTask {
  name: string;
  frequency: string | null;
  enabled: boolean;
  teamId: string | null;
  target: "application" | "service" | null;
  targetName: string | null;
}
export interface InvBackup {
  databaseType: string | null;
  databaseName: string | null;
  frequency: string | null;
  enabled: boolean;
  toS3: boolean;
  s3Name: string | null;
  teamId: string | null;
}
export interface InvStorage {
  name: string;
  bucket: string | null;
  region: string | null;
  endpoint: string | null;
  hasKeys: boolean;
  teamId: string | null;
}
export interface InvGitSource {
  kind: "github" | "gitlab";
  name: string;
  organization: string | null;
  host: string | null;
  teamId: string | null;
}

export interface CoolifyInventoryData {
  v: 1;
  instance: { name: string | null; fqdn: string | null; ip: string | null; image: string | null };
  teams: InvTeam[];
  servers: InvServer[];
  projects: InvProject[];
  applications: InvApp[];
  databases: InvDb[];
  services: InvService[];
  sharedVariables: InvSharedVariable[];
  scheduledTasks: InvTask[];
  backups: InvBackup[];
  storages: InvStorage[];
  gitSources: InvGitSource[];
  /** Sections this Coolify version does not have (or that could not be read). Normal for older versions. */
  unavailable: string[];
}

export interface InventoryCounts {
  teams: number;
  servers: number;
  projects: number;
  applications: number;
  databases: number;
  services: number;
  sharedVariables: number;
  scheduledTasks: number;
  backups: number;
  storages: number;
}

// ---- raw output -----------------------------------------------------------------------------------------------------

type Row = Record<string, unknown>;

export interface RawRead {
  image: string | null;
  sections: Map<string, Row[]>;
  skipped: string[];
}

/** Split the script output into sections; throws {@link CoolifyReadError} for the failure markers. */
export function parseRead(output: string): RawRead {
  if (output.includes(CFY.noDocker)) throw new CoolifyReadError("no_docker");
  if (output.includes(CFY.noCoolify)) throw new CoolifyReadError("no_coolify");
  if (output.includes(CFY.stopped)) throw new CoolifyReadError("db_stopped");
  if (!output.includes(CFY.done)) throw new CoolifyReadError("unreadable");
  const ro = /^TUGRA_CFY_RO (.*)$/m.exec(output);
  // The database must have confirmed the read-only session before anything it returned is trusted.
  if (!ro || ro[1].trim() !== "on") throw new CoolifyReadError("not_read_only");

  const imageLine = /^TUGRA_CFY_IMAGE (.*)$/m.exec(output);
  const image = imageLine ? bound(imageLine[1].trim(), 200) : null;

  const sections = new Map<string, Row[]>();
  const skipped: string[] = [];
  const lines = output.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith(CFY.skip)) {
      skipped.push(line.slice(CFY.skip.length).trim());
    } else if (line.startsWith(CFY.begin)) {
      const name = line.slice(CFY.begin.length).trim();
      const body: string[] = [];
      let j = i + 1;
      for (; j < lines.length && !lines[j].startsWith(`${CFY.end}${name}`); j++) body.push(lines[j]);
      i = j;
      sections.set(name, parseRows(body.join("\n")));
    }
  }
  return { image, sections, skipped };
}

function parseRows(text: string): Row[] {
  const t = text.trim();
  if (!t.startsWith("[")) return [];
  try {
    const v: unknown = JSON.parse(t);
    return Array.isArray(v) ? v.filter((r): r is Row => !!r && typeof r === "object" && !Array.isArray(r)) : [];
  } catch {
    return [];
  }
}

// ---- field pickers --------------------------------------------------------------------------------------------------

const bound = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);
const str = (v: unknown, n = 300): string | null => (typeof v === "string" && v !== "" ? bound(v, n) : typeof v === "number" ? String(v) : null);
const idOf = (v: unknown): string | null => (typeof v === "number" || typeof v === "string") && String(v) !== "" ? bound(String(v), 40) : null;
const flag = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const yes = (v: unknown): boolean => v === true;
const int = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : d);

/** Last line of defence on stored text: a `user:password@` part of a URL never survives. */
export function scrubText(v: string | null): string | null {
  if (v === null) return null;
  return v.replace(/:\/\/[^/@\s]*@/g, "://");
}

const MAX_ITEMS = 20_000;
const rows = (r: RawRead, name: string): Row[] => (r.sections.get(name) ?? []).slice(0, MAX_ITEMS);

/** `App\Models\Application` -> `application` (Coolify's polymorphic type names). */
function modelKind(v: unknown): string {
  const s = typeof v === "string" ? v : "";
  return (s.split("\\").pop() ?? "").toLowerCase();
}

// ---- normalisation --------------------------------------------------------------------------------------------------

export function buildInventory(raw: RawRead): { data: CoolifyInventoryData; counts: InventoryCounts } {
  const unavailable = new Set(raw.skipped);

  // Teams (+ members + notification settings).
  const members = new Map<string, number>();
  for (const m of rows(raw, "team_members")) {
    const t = idOf(m.team_id);
    if (t) members.set(t, (members.get(t) ?? 0) + 1);
  }
  const notifications = new Map<string, Array<{ channel: string; enabled: boolean; configured: boolean }>>();
  const addNotification = (teamId: string | null, channel: string, row: Row) => {
    if (!teamId) return;
    const enabled = Object.entries(row).some(([k, v]) => /_enabled$/.test(k) && v === true);
    const configured = Object.entries(row).some(([k, v]) => /_present$/.test(k) && v === true);
    if (!enabled && !configured) return;
    const list = notifications.get(teamId) ?? [];
    if (!list.some((n) => n.channel === channel)) list.push({ channel, enabled, configured });
    notifications.set(teamId, list);
  };
  for (const ch of ["email", "discord", "telegram", "slack", "pushover", "webhook"]) {
    for (const n of rows(raw, `notify_${ch}`)) addNotification(idOf(n.team_id), ch, n);
  }
  // Older Coolify versions keep the notification settings on the team row itself.
  const teamRows = rows(raw, "teams");
  for (const t of teamRows) {
    for (const ch of ["email", "discord", "telegram", "slack", "pushover", "webhook"]) {
      const prefix = ch === "email" ? "smtp" : ch;
      const sub: Row = {};
      for (const [k, v] of Object.entries(t)) if (k.startsWith(`${prefix}_`)) sub[k] = v;
      addNotification(idOf(t.id), ch, sub);
    }
  }
  const teams: InvTeam[] = teamRows
    .map((t) => ({ id: idOf(t.id), name: str(t.name, 120), t }))
    .filter((x): x is { id: string; name: string | null; t: Row } => !!x.id)
    .map(({ id, name, t }) => ({
      id,
      name: name ?? `Team ${id}`,
      description: scrubText(str(t.description, 300)),
      personal: yes(t.personal_team),
      members: members.get(id) ?? 0,
      notifications: (notifications.get(id) ?? []).sort((a, b) => a.channel.localeCompare(b.channel)),
    }));

  // Projects and environments.
  const envs = rows(raw, "environments");
  const envById = new Map<string, { name: string; projectId: string | null }>();
  const envsByProject = new Map<string, Array<{ id: string; uuid: string; name: string }>>();
  for (const e of envs) {
    const id = idOf(e.id);
    if (!id) continue;
    const name = str(e.name, 120) ?? `Environment ${id}`;
    const projectId = idOf(e.project_id);
    envById.set(id, { name, projectId });
    if (projectId) {
      const list = envsByProject.get(projectId) ?? [];
      list.push({ id, uuid: str(e.uuid, 80) ?? "", name });
      envsByProject.set(projectId, list);
    }
  }
  const projectRows = rows(raw, "projects");
  const projectById = new Map<string, { teamId: string | null }>();
  const projects: InvProject[] = [];
  for (const p of projectRows) {
    const id = idOf(p.id);
    if (!id) continue;
    projectById.set(id, { teamId: idOf(p.team_id) });
    projects.push({
      id,
      uuid: str(p.uuid, 80) ?? "",
      name: str(p.name, 120) ?? `Project ${id}`,
      description: scrubText(str(p.description, 300)),
      teamId: idOf(p.team_id),
      environments: envsByProject.get(id) ?? [],
    });
  }

  // Docker destinations -> server.
  const destServer = new Map<string, string>();
  for (const [section, model] of [["docker_standalone", "standalonedocker"], ["docker_swarm", "swarmdocker"]] as const) {
    for (const d of rows(raw, section)) {
      const id = idOf(d.id);
      const server = idOf(d.server_id);
      if (id && server) destServer.set(`${model}:${id}`, server);
    }
  }
  const serverOfDestination = (type: unknown, id: unknown): string | null => {
    const k = idOf(id);
    return k ? (destServer.get(`${modelKind(type)}:${k}`) ?? null) : null;
  };
  const place = (environmentId: unknown): Pick<Resource, "teamId" | "projectId" | "environment"> => {
    const env = envById.get(idOf(environmentId) ?? "");
    const projectId = env?.projectId ?? null;
    return { teamId: projectId ? (projectById.get(projectId)?.teamId ?? null) : null, projectId, environment: env?.name ?? null };
  };

  // Environment variables: counts per resource only (names of resource variables are not stored, values do not exist here).
  const envCount = new Map<string, number>();
  const previewCount = new Map<string, number>();
  for (const v of rows(raw, "env_vars")) {
    const owner = idOf(v.resourceable_id);
    const kind = modelKind(v.resourceable_type);
    if (!owner || !kind) continue;
    const key = `${kind}:${owner}`;
    (v.is_preview === true ? previewCount : envCount).set(key, ((v.is_preview === true ? previewCount : envCount).get(key) ?? 0) + 1);
  }

  const applications: InvApp[] = [];
  for (const a of rows(raw, "applications")) {
    const id = idOf(a.id);
    if (!id) continue;
    const image = [str(a.docker_registry_image_name, 200), str(a.docker_registry_image_tag, 80)].filter(Boolean).join(":");
    applications.push({
      id,
      uuid: str(a.uuid, 80) ?? "",
      name: str(a.name, 160) ?? `Application ${id}`,
      fqdn: scrubText(str(a.fqdn, 500)),
      gitRepository: scrubText(str(a.git_repository, 300)),
      gitBranch: str(a.git_branch, 120),
      buildPack: str(a.build_pack, 40),
      image: image || null,
      status: str(a.status, 60),
      envCount: envCount.get(`application:${id}`) ?? 0,
      previewEnvCount: previewCount.get(`application:${id}`) ?? 0,
      hasCompose: yes(a.docker_compose_raw_present),
      ...place(a.environment_id),
      serverId: serverOfDestination(a.destination_type, a.destination_id),
    });
  }

  const databases: InvDb[] = [];
  const known = new Set(SECTIONS.map((s) => s.name));
  for (const section of [...raw.sections.keys()].filter((s) => s.startsWith("db_") && known.has(s)).sort()) {
    for (const d of rows(raw, section)) {
      const id = idOf(d.id);
      if (!id) continue;
      databases.push({
        id,
        uuid: str(d.uuid, 80) ?? "",
        name: str(d.name, 160) ?? `Database ${id}`,
        type: str(d.type, 30) ?? section.slice(3),
        image: str(d.image, 200),
        status: str(d.status, 60),
        isPublic: yes(d.is_public),
        ...place(d.environment_id),
        serverId: serverOfDestination(d.destination_type, d.destination_id),
      });
    }
  }

  const componentCount = new Map<string, number>();
  for (const section of ["service_apps", "service_dbs"]) {
    for (const c of rows(raw, section)) {
      const sid = idOf(c.service_id);
      if (sid) componentCount.set(sid, (componentCount.get(sid) ?? 0) + 1);
    }
  }
  const services: InvService[] = [];
  for (const s of rows(raw, "services")) {
    const id = idOf(s.id);
    if (!id) continue;
    services.push({
      id,
      uuid: str(s.uuid, 80) ?? "",
      name: str(s.name, 160) ?? `Service ${id}`,
      kind: str(s.service_type, 80),
      components: componentCount.get(id) ?? 0,
      envCount: (envCount.get(`service:${id}`) ?? 0) + (previewCount.get(`service:${id}`) ?? 0),
      ...place(s.environment_id),
      serverId: idOf(s.server_id) ?? serverOfDestination(s.destination_type, s.destination_id),
    });
  }

  // Servers.
  const settings = new Map<string, Row>();
  for (const s of rows(raw, "server_settings")) {
    const id = idOf(s.server_id);
    if (id) settings.set(id, s);
  }
  const keyName = new Map<string, string>();
  for (const k of rows(raw, "private_keys")) {
    const id = idOf(k.id);
    const name = str(k.name, 120);
    if (id && name) keyName.set(id, name);
  }
  const countBy = <T extends { serverId: string | null }>(xs: T[], id: string): number => xs.filter((x) => x.serverId === id).length;
  const servers: InvServer[] = [];
  for (const s of rows(raw, "servers")) {
    const id = idOf(s.id);
    const ip = str(s.ip, 255);
    if (!id || !ip) continue;
    const cfg = settings.get(id) ?? {};
    servers.push({
      id,
      uuid: str(s.uuid, 80) ?? "",
      name: str(s.name, 160) ?? `Server ${id}`,
      description: scrubText(str(s.description, 300)),
      ip,
      port: int(s.port, 22),
      user: str(s.user, 64) ?? "root",
      teamId: idOf(s.team_id),
      isLocal: id === "0" || ip === "host.docker.internal",
      reachable: flag(cfg.is_reachable),
      usable: flag(cfg.is_usable),
      buildServer: yes(cfg.is_build_server),
      swarm: yes(cfg.is_swarm_manager) || yes(cfg.is_swarm_worker),
      keyName: keyName.get(idOf(s.private_key_id) ?? "") ?? null,
      apps: countBy(applications, id),
      databases: countBy(databases, id),
      services: countBy(services, id),
    });
  }

  // Shared variables: scope + key name only.
  const sharedVariables: InvSharedVariable[] = [];
  for (const v of rows(raw, "shared_vars")) {
    const key = str(v.key, 160);
    const scope = v.type === "team" || v.type === "project" || v.type === "environment" ? v.type : null;
    if (!key || !scope) continue;
    const projectId = idOf(v.project_id);
    const envId = idOf(v.environment_id);
    const env = envId ? envById.get(envId) : undefined;
    const effectiveProject = projectId ?? env?.projectId ?? null;
    sharedVariables.push({
      scope,
      teamId: idOf(v.team_id) ?? (effectiveProject ? (projectById.get(effectiveProject)?.teamId ?? null) : null),
      projectId: effectiveProject,
      environment: env?.name ?? null,
      key,
    });
  }
  sharedVariables.sort((a, b) => a.scope.localeCompare(b.scope) || a.key.localeCompare(b.key));

  // Scheduled tasks.
  const appName = new Map(applications.map((a) => [a.id, a.name]));
  const serviceName = new Map(services.map((s) => [s.id, s.name]));
  const scheduledTasks: InvTask[] = rows(raw, "scheduled_tasks").map((t) => {
    const app = idOf(t.application_id);
    const svc = idOf(t.service_id);
    return {
      name: str(t.name, 160) ?? "Task",
      frequency: str(t.frequency, 80),
      enabled: t.enabled !== false,
      teamId: idOf(t.team_id),
      target: app ? "application" : svc ? "service" : null,
      targetName: (app ? appName.get(app) : svc ? serviceName.get(svc) : null) ?? null,
    };
  });

  // Storages and backups.
  const storageName = new Map<string, string>();
  const storages: InvStorage[] = [];
  for (const s of rows(raw, "s3")) {
    const id = idOf(s.id);
    const name = str(s.name, 160) ?? (id ? `Storage ${id}` : null);
    if (!name) continue;
    if (id) storageName.set(id, name);
    storages.push({
      name,
      bucket: str(s.bucket, 200),
      region: str(s.region, 60),
      endpoint: scrubText(str(s.endpoint, 300)),
      hasKeys: yes(s.key_present) && yes(s.secret_present),
      teamId: idOf(s.team_id),
    });
  }
  const dbById = new Map(databases.map((d) => [`${d.type}:${d.id}`, d]));
  const backups: InvBackup[] = rows(raw, "backups").map((b) => {
    const type = modelKind(b.database_type).replace(/^standalone/, "");
    const db = dbById.get(`${type}:${idOf(b.database_id) ?? ""}`);
    return {
      databaseType: type || null,
      databaseName: db?.name ?? null,
      frequency: str(b.frequency, 80),
      enabled: b.enabled !== false,
      toS3: yes(b.save_s3),
      s3Name: storageName.get(idOf(b.s3_storage_id) ?? "") ?? null,
      teamId: idOf(b.team_id) ?? db?.teamId ?? null,
    };
  });

  const gitSources: InvGitSource[] = [];
  for (const [section, kind] of [["git_github", "github"], ["git_gitlab", "gitlab"]] as const) {
    for (const g of rows(raw, section)) {
      const name = str(g.name, 160);
      if (!name) continue;
      gitSources.push({ kind, name, organization: str(g.organization, 120), host: scrubText(str(g.html_url, 300)), teamId: idOf(g.team_id) });
    }
  }

  const inst = rows(raw, "instance")[0] ?? {};
  const publicSections = new Set(SECTIONS.map((s) => s.name));
  const data: CoolifyInventoryData = {
    v: 1,
    instance: { name: str(inst.instance_name, 160), fqdn: scrubText(str(inst.fqdn, 300)), ip: str(inst.public_ipv4, 64), image: raw.image },
    teams,
    servers,
    projects,
    applications,
    databases,
    services,
    sharedVariables: sharedVariables.slice(0, 5000),
    scheduledTasks,
    backups,
    storages,
    gitSources,
    unavailable: [...unavailable].filter((n) => publicSections.has(n)).sort(),
  };
  return {
    data,
    counts: {
      teams: teams.length,
      servers: servers.length,
      projects: projects.length,
      applications: applications.length,
      databases: databases.length,
      services: services.length,
      sharedVariables: sharedVariables.length,
      scheduledTasks: scheduledTasks.length,
      backups: backups.length,
      storages: storages.length,
    },
  };
}
