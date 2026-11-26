// Types and pure helpers for "Read this Coolify" (a read-only inventory of a Coolify instance, read through the agent on its host).
// The shapes mirror apps/hub-api/src/coolify-takeover. The inventory holds no secret value.

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
interface Placed {
  teamId: string | null;
  projectId: string | null;
  environment: string | null;
  serverId: string | null;
}
export interface InvProject {
  id: string;
  uuid: string;
  name: string;
  description: string | null;
  teamId: string | null;
  environments: Array<{ id: string; uuid: string; name: string }>;
}
export interface InvApp extends Placed {
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
export interface InvDb extends Placed {
  id: string;
  uuid: string;
  name: string;
  type: string;
  image: string | null;
  status: string | null;
  isPublic: boolean;
}
export interface InvService extends Placed {
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
  unavailable: string[];
}

export interface CoolifyCounts {
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

export interface CoolifyInventoryView {
  serverId: string;
  serverName: string;
  teamId: string;
  enabledAt: string;
  readAt: string | null;
  coolifyImage: string | null;
  counts: CoolifyCounts | null;
  data: CoolifyInventoryData | null;
}

export type CoolifyDetect = { found: boolean; image: string | null; reason?: "no_docker" | "db_stopped" };

export type ChecklistState = "this_server" | "already_added" | "waiting" | "expired" | "no_access" | "not_generated" | "ambiguous";
export interface ChecklistRow {
  coolifyServerId: string;
  /** Coolify's own uuid of the server: what the SSH install names. */
  coolifyServerUuid: string;
  name: string;
  ip: string;
  port: number;
  user: string;
  state: ChecklistState;
  teamId: string | null;
  tugraServerId: string | null;
  installCommand: string | null;
  expiresAt: string | null;
  ssh: string;
  /** An "already_added" row matched only by an address guess: the owner can check it by its identity. */
  probable?: boolean;
}
export interface CoolifyChecklist {
  rows: ChecklistRow[];
  teams: Array<{ id: string; name: string }>;
}

// ---- helpers --------------------------------------------------------------------------------------------------------

/** `ghcr.io/coollabsio/coolify:4.0.0-beta.4` -> `4.0.0-beta.4` (null when there is no tag). */
export function coolifyVersion(image: string | null | undefined): string | null {
  if (!image) return null;
  const tag = image.split("@")[0].split(":").slice(1).join(":");
  return tag || null;
}

/** Same-tab handoff key: the inventory page leaves the Coolify address here, the import wizard reads it once. Never a URL parameter. */
export const IMPORT_PREFILL_KEY = "tugra.import.prefillUrl";

/** The Coolify address of this instance when it is a plain http(s) address, else null. */
export function coolifyAddress(fqdn: string | null | undefined): string | null {
  const first = (fqdn ?? "").split(",")[0].trim();
  return /^https?:\/\/[^\s]+$/i.test(first) ? first : null;
}

/** Remember the address for the import wizard (same origin, same tab). Best effort. */
export function rememberImportAddress(address: string | null): void {
  try {
    if (address) window.sessionStorage.setItem(IMPORT_PREFILL_KEY, address);
  } catch {
    /* storage unavailable: the first field simply starts empty */
  }
}

export type ItemKind = "application" | "database" | "service";
export interface InventoryItem {
  key: string;
  kind: ItemKind;
  name: string;
  /** Address, image or type: the one line that identifies it. */
  detail: string | null;
  status: string | null;
  environment: string | null;
  /** The server it runs on (Coolify server name), when known. */
  server: string | null;
  /** Where it lives in Coolify, as the import names them: the server's uuid, its internal id (what the checklist uses) and the project's uuid. */
  serverUuid: string | null;
  serverDbId: string | null;
  projectUuid: string | null;
}
export interface ProjectGroup {
  id: string;
  name: string | null;
  items: InventoryItem[];
}
export interface TeamGroup {
  id: string;
  /** null = resources that sit in no Coolify team. */
  team: InvTeam | null;
  servers: InvServer[];
  projects: ProjectGroup[];
  sharedVariables: InvSharedVariable[];
  tasks: InvTask[];
  backups: InvBackup[];
  storages: InvStorage[];
  gitSources: InvGitSource[];
}

const KIND_ORDER: Record<ItemKind, number> = { application: 0, database: 1, service: 2 };

/** The inventory, grouped the way Coolify shows it: team, then project, then what runs in it. */
export function groupByTeam(data: CoolifyInventoryData): TeamGroup[] {
  const serverName = new Map(data.servers.map((s) => [s.id, s.name]));
  const serverUuid = new Map(data.servers.map((s) => [s.id, s.uuid]));
  const projectUuid = new Map(data.projects.map((p) => [p.id, p.uuid]));
  const where = (serverId: string | null, projectId: string | null) => ({
    serverUuid: serverUuid.get(serverId ?? "") ?? null,
    serverDbId: serverId && serverUuid.has(serverId) ? serverId : null,
    projectUuid: projectUuid.get(projectId ?? "") ?? null,
  });
  const projectName = new Map(data.projects.map((p) => [p.id, p.name]));
  const groups = new Map<string, TeamGroup>();
  const blank = (id: string, team: InvTeam | null): TeamGroup => ({ id, team, servers: [], projects: [], sharedVariables: [], tasks: [], backups: [], storages: [], gitSources: [] });
  for (const t of data.teams) groups.set(t.id, blank(t.id, t));
  const of = (teamId: string | null): TeamGroup => {
    const key = teamId && groups.has(teamId) ? teamId : "";
    if (!groups.has(key)) groups.set(key, blank(key, null));
    return groups.get(key)!;
  };
  for (const s of data.servers) of(s.teamId).servers.push(s);
  for (const p of data.projects) {
    const g = of(p.teamId);
    if (!g.projects.some((x) => x.id === p.id)) g.projects.push({ id: p.id, name: p.name, items: [] });
  }
  const put = (teamId: string | null, projectId: string | null, item: InventoryItem) => {
    const g = of(teamId);
    const pid = projectId && projectName.has(projectId) ? projectId : "";
    let proj = g.projects.find((x) => x.id === pid);
    if (!proj) {
      proj = { id: pid, name: pid ? (projectName.get(pid) ?? null) : null, items: [] };
      g.projects.push(proj);
    }
    proj.items.push(item);
  };
  for (const a of data.applications) {
    put(a.teamId, a.projectId, {
      key: `a${a.id}`, kind: "application", name: a.name, detail: a.fqdn ?? a.gitRepository ?? a.image, status: a.status, environment: a.environment, server: serverName.get(a.serverId ?? "") ?? null, ...where(a.serverId, a.projectId),
    });
  }
  for (const d of data.databases) {
    put(d.teamId, d.projectId, { key: `d${d.type}${d.id}`, kind: "database", name: d.name, detail: d.image ?? d.type, status: d.status, environment: d.environment, server: serverName.get(d.serverId ?? "") ?? null, ...where(d.serverId, d.projectId) });
  }
  for (const s of data.services) {
    put(s.teamId, s.projectId, { key: `s${s.id}`, kind: "service", name: s.name, detail: s.kind, status: null, environment: s.environment, server: serverName.get(s.serverId ?? "") ?? null, ...where(s.serverId, s.projectId) });
  }
  for (const v of data.sharedVariables) of(v.teamId).sharedVariables.push(v);
  for (const t of data.scheduledTasks) of(t.teamId).tasks.push(t);
  for (const b of data.backups) of(b.teamId).backups.push(b);
  for (const s of data.storages) of(s.teamId).storages.push(s);
  for (const g of data.gitSources) of(g.teamId).gitSources.push(g);
  for (const g of groups.values()) {
    for (const p of g.projects) p.items.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name));
    g.projects.sort((a, b) => (a.id === "" ? 1 : b.id === "" ? -1 : (a.name ?? "").localeCompare(b.name ?? "")));
    g.projects = g.projects.filter((p) => p.id !== "" || p.items.length > 0);
  }
  return [...groups.values()].filter((g) => g.team || g.projects.length > 0 || g.servers.length > 0 || g.sharedVariables.length > 0 || g.tasks.length > 0 || g.backups.length > 0 || g.storages.length > 0 || g.gitSources.length > 0);
}

/** Running states (Coolify writes `running:healthy`, `exited:unhealthy`, ...) to a badge tone. */
export function statusTone(status: string | null): "ok" | "warn" | "muted" {
  const s = (status ?? "").toLowerCase();
  if (s.startsWith("running")) return s.includes("unhealthy") ? "warn" : "ok";
  if (s.startsWith("exited") || s.startsWith("degraded") || s.includes("unhealthy")) return "warn";
  return "muted";
}

/** All pending install commands as one pasteable block, each under a comment saying where to run it. */
export function allCommands(rows: ChecklistRow[]): string {
  return rows
    .filter((r) => r.state === "waiting" && r.installCommand)
    .map((r) => `# ${r.name.replace(/[\r\n]+/g, " ")} (${r.ssh})\n${r.installCommand}`)
    .join("\n\n");
}
