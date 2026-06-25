import type {
  ApiToken,
  Application,
  AppVolume,
  BulkOperation,
  Backup,
  BackupDestination,
  AuditEntry,
  Channel,
  Database,
  GitSource,
  SourceRepo,
  VolumeBackup,
  DbEngine,
  Deployment,
  DomainView,
  Heartbeat,
  MetricsSample,
  Monitor,
  LogDrain,
  MyInvitation,
  PatchInfo,
  ProxyStatus,
  PublicUser,
  Project,
  Role,
  ScheduledTask,
  ServerView,
  SharedVariable,
  Team,
  TeamInvitation,
  TeamMember,
  Template,
  TokenPair,
} from "./types";

export const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

const ACCESS_KEY = "tugra.access";
const REFRESH_KEY = "tugra.refresh";

export const tokens = {
  access(): string | null {
    if (typeof localStorage === "undefined") return null;
    return localStorage.getItem(ACCESS_KEY);
  },
  refresh(): string | null {
    if (typeof localStorage === "undefined") return null;
    return localStorage.getItem(REFRESH_KEY);
  },
  set(pair: TokenPair): void {
    localStorage.setItem(ACCESS_KEY, pair.accessToken);
    localStorage.setItem(REFRESH_KEY, pair.refreshToken);
  },
  clear(): void {
    if (typeof localStorage === "undefined") return;
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
  },
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function tryRefresh(): Promise<boolean> {
  const rt = tokens.refresh();
  if (!rt) return false;
  const res = await fetch(`${API_BASE}/auth/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken: rt }),
  });
  if (!res.ok) {
    tokens.clear();
    return false;
  }
  tokens.set((await res.json()) as TokenPair);
  return true;
}

export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
  retry = true,
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  const access = tokens.access();
  if (access) headers.set("authorization", `Bearer ${access}`);

  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });

  if (res.status === 401 && retry && (await tryRefresh())) {
    return apiFetch<T>(path, init, false);
  }
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const body = await res.json();
      msg = Array.isArray(body?.message)
        ? body.message.join(", ")
        : (body?.message ?? msg);
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, msg);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ── typed endpoints ────────────────────────────────────────────────

export const api = {
  async register(email: string, password: string, name?: string) {
    const out = await apiFetch<{ user: PublicUser; tokens: TokenPair }>(
      "/auth/register",
      { method: "POST", body: JSON.stringify({ email, password, name }) },
      false,
    );
    tokens.set(out.tokens);
    return out.user;
  },

  async login(email: string, password: string, totp?: string) {
    const out = await apiFetch<
      { tokens: TokenPair } | { twoFaRequired: true }
    >(
      "/auth/login",
      { method: "POST", body: JSON.stringify({ email, password, totp }) },
      false,
    );
    if ("tokens" in out) tokens.set(out.tokens);
    return out;
  },

  me() {
    return apiFetch<PublicUser>("/auth/me");
  },

  async logout() {
    const rt = tokens.refresh();
    if (rt) {
      await apiFetch(
        "/auth/logout",
        { method: "POST", body: JSON.stringify({ refreshToken: rt }) },
        false,
      ).catch(() => undefined);
    }
    tokens.clear();
  },

  setup2fa() {
    return apiFetch<{ otpauthUrl: string; qrDataUrl: string }>(
      "/auth/2fa/setup",
      { method: "POST" },
    );
  },

  enable2fa(token: string) {
    return apiFetch<{ ok: true }>("/auth/2fa/enable", {
      method: "POST",
      body: JSON.stringify({ token }),
    });
  },

  listTeams() {
    return apiFetch<Team[]>("/teams");
  },
  createTeam(name: string) {
    return apiFetch<Team>("/teams", { method: "POST", body: JSON.stringify({ name }) });
  },
  renameTeam(id: string, name: string) {
    return apiFetch<{ ok: true }>(`/teams/${id}`, { method: "PUT", body: JSON.stringify({ name }) });
  },
  deleteTeam(id: string) {
    return apiFetch<{ ok: true }>(`/teams/${id}`, { method: "DELETE" });
  },
  listTeamMembers(id: string) {
    return apiFetch<TeamMember[]>(`/teams/${id}/members`);
  },
  inviteTeamMember(id: string, email: string, role: Role) {
    return apiFetch<TeamInvitation>(`/teams/${id}/members/invite`, {
      method: "POST",
      body: JSON.stringify({ email, role }),
    });
  },
  listTeamInvitations(id: string) {
    return apiFetch<TeamInvitation[]>(`/teams/${id}/invitations`);
  },
  revokeTeamInvitation(id: string, invId: string) {
    return apiFetch<{ ok: true }>(`/teams/${id}/invitations/${invId}`, { method: "DELETE" });
  },
  setTeamMemberRole(id: string, userId: string, role: Role) {
    return apiFetch<{ ok: true }>(`/teams/${id}/members/${userId}`, {
      method: "PUT",
      body: JSON.stringify({ role }),
    });
  },
  removeTeamMember(id: string, userId: string) {
    return apiFetch<{ ok: true }>(`/teams/${id}/members/${userId}`, { method: "DELETE" });
  },
  myInvitations() {
    return apiFetch<MyInvitation[]>("/teams/invitations/mine");
  },
  acceptInvitation(token: string) {
    return apiFetch<{ ok: true }>(`/teams/invitations/${token}/accept`, { method: "POST" });
  },
  declineInvitation(token: string) {
    return apiFetch<{ ok: true }>(`/teams/invitations/${token}/decline`, { method: "POST" });
  },

  listServers(params?: { teamId?: string; status?: string }) {
    const q = new URLSearchParams();
    if (params?.teamId) q.set("teamId", params.teamId);
    if (params?.status) q.set("status", params.status);
    const qs = q.toString();
    return apiFetch<ServerView[]>(`/servers${qs ? `?${qs}` : ""}`);
  },

  getServer(id: string) {
    return apiFetch<ServerView>(`/servers/${id}`);
  },

  getMetrics(id: string, limit = 60) {
    return apiFetch<MetricsSample[]>(`/servers/${id}/metrics?limit=${limit}`);
  },

  cleanupServer(id: string) {
    return apiFetch<{ output: string }>(`/servers/${id}/cleanup`, { method: "POST" });
  },
  getProxyStatus(id: string) {
    return apiFetch<{ status: ProxyStatus }>(`/servers/${id}/proxy`);
  },
  startProxy(id: string) {
    return apiFetch<{ status: ProxyStatus }>(`/servers/${id}/proxy/start`, { method: "POST" });
  },
  stopProxy(id: string) {
    return apiFetch<{ status: ProxyStatus }>(`/servers/${id}/proxy/stop`, { method: "POST" });
  },
  restartProxy(id: string) {
    return apiFetch<{ status: ProxyStatus }>(`/servers/${id}/proxy/restart`, { method: "POST" });
  },
  getProxyLogs(id: string, tail?: number) {
    return apiFetch<{ output: string }>(`/servers/${id}/proxy/logs${tail ? `?tail=${tail}` : ""}`);
  },
  setServerTags(id: string, tags: string[]) {
    return apiFetch<{ ok: true }>(`/servers/${id}/tags`, {
      method: "PUT",
      body: JSON.stringify({ tags }),
    });
  },
  checkUpdates(id: string) {
    return apiFetch<PatchInfo>(`/servers/${id}/updates`);
  },
  listLogDrains(serverId: string) {
    return apiFetch<LogDrain[]>(`/servers/${serverId}/log-drains`);
  },
  createLogDrain(serverId: string, input: { name: string; endpoint: string; token?: string; enabled?: boolean }) {
    return apiFetch<LogDrain>(`/servers/${serverId}/log-drains`, { method: "POST", body: JSON.stringify(input) });
  },
  updateLogDrain(serverId: string, drainId: string, input: { name?: string; endpoint?: string; token?: string | null; enabled?: boolean }) {
    return apiFetch<LogDrain>(`/servers/${serverId}/log-drains/${drainId}`, { method: "PUT", body: JSON.stringify(input) });
  },
  deleteLogDrain(serverId: string, drainId: string) {
    return apiFetch<{ ok: true }>(`/servers/${serverId}/log-drains/${drainId}`, { method: "DELETE" });
  },
  upgradeAll(id: string) {
    return apiFetch<{ output: string; exitCode: number }>(`/servers/${id}/updates/apply`, { method: "POST" });
  },
  upgradeOne(id: string, pkg: string) {
    return apiFetch<{ output: string; exitCode: number }>(`/servers/${id}/updates/apply/${pkg}`, { method: "POST" });
  },
  setCleanupConfig(id: string, cfg: { enabled: boolean; intervalHours?: number; volumes?: boolean }) {
    return apiFetch<{ ok: true }>(`/servers/${id}/cleanup-config`, {
      method: "PUT",
      body: JSON.stringify(cfg),
    });
  },

  createServer(name: string, teamId: string) {
    return apiFetch<{
      server: ServerView;
      enrollToken: string;
      installCommand: string;
    }>("/servers", {
      method: "POST",
      body: JSON.stringify({ name, teamId }),
    });
  },

  // ── monitors ──
  listMonitors() {
    return apiFetch<Monitor[]>("/monitors");
  },
  getMonitor(id: string) {
    return apiFetch<Monitor>(`/monitors/${id}`);
  },
  createMonitor(input: {
    name: string;
    type: "HTTP" | "TCP" | "METRIC";
    target?: string;
    serverId?: string;
    metric?: "DISK" | "CPU" | "MEM";
    thresholdPct?: number;
    teamId: string;
    channelIds?: string[];
    intervalSec?: number;
    retries?: number;
    timeoutMs?: number;
  }) {
    return apiFetch<Monitor>("/monitors", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  updateMonitor(
    id: string,
    input: {
      name?: string;
      intervalSec?: number;
      retries?: number;
      timeoutMs?: number;
      resendEvery?: number;
      enabled?: boolean;
      channelIds?: string[];
    },
  ) {
    return apiFetch<Monitor>(`/monitors/${id}`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
  },
  checkMonitor(id: string) {
    return apiFetch<{ status: string; ms: number; msg: string }>(
      `/monitors/${id}/check`,
      { method: "POST" },
    );
  },
  getHeartbeats(id: string, limit = 60) {
    return apiFetch<Heartbeat[]>(`/monitors/${id}/heartbeats?limit=${limit}`);
  },
  getUptime(id: string) {
    return apiFetch<{ percent: number; total: number }>(
      `/monitors/${id}/uptime`,
    );
  },

  // ── notification channels ──
  listChannels() {
    return apiFetch<Channel[]>("/channels");
  },
  createChannel(input: {
    name: string;
    type: string;
    teamId: string;
    config: Record<string, unknown>;
    eventTypes?: string[];
  }) {
    return apiFetch<Channel>("/channels", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  updateChannel(id: string, input: { name?: string; enabled?: boolean; eventTypes?: string[]; config?: Record<string, unknown> }) {
    return apiFetch<Channel>(`/channels/${id}`, { method: "PUT", body: JSON.stringify(input) });
  },
  testChannel(id: string) {
    return apiFetch<{ ok: true }>(`/channels/${id}/test`, { method: "POST" });
  },
  deleteChannel(id: string) {
    return apiFetch<{ ok: true }>(`/channels/${id}`, { method: "DELETE" });
  },

  // ── git sources (GitHub App) ──
  listAudit(teamId?: string) {
    return apiFetch<AuditEntry[]>(`/audit${teamId ? `?teamId=${teamId}` : ""}`);
  },
  listGitSources() {
    return apiFetch<GitSource[]>("/git-sources");
  },
  createGitSource(input: {
    name: string;
    teamId: string;
    appId: string;
    privateKey: string;
    installationId?: string;
    webhookSecret?: string;
  }) {
    return apiFetch<GitSource>("/git-sources", { method: "POST", body: JSON.stringify(input) });
  },
  listSourceRepos(id: string) {
    return apiFetch<SourceRepo[]>(`/git-sources/${id}/repos`);
  },
  deleteGitSource(id: string) {
    return apiFetch<{ ok: true }>(`/git-sources/${id}`, { method: "DELETE" });
  },

  // ── bulk ops ──
  runBulk(serverIds: string[], command: string) {
    return apiFetch<{ opId: string }>("/bulk", {
      method: "POST",
      body: JSON.stringify({ serverIds, command }),
    });
  },
  getBulk(id: string) {
    return apiFetch<BulkOperation>(`/bulk/${id}`);
  },

  // ── applications (deploy) ──
  listApps() {
    return apiFetch<Application[]>("/apps");
  },
  getApp(id: string) {
    return apiFetch<Application>(`/apps/${id}`);
  },
  createApp(input: {
    name: string;
    serverId: string;
    source?: "IMAGE" | "GIT" | "COMPOSE";
    image?: string;
    gitUrl?: string;
    gitBranch?: string;
    gitSourceId?: string;
    buildType?: "NIXPACKS" | "DOCKERFILE" | "STATIC" | "RAILPACK" | "HEROKU";
    buildCommand?: string;
    outputDir?: string;
    composeFile?: string;
    hostPort?: number;
    containerPort?: number;
    domain?: string;
    env?: Record<string, string>;
    tags?: string[];
    environmentId?: string;
  }) {
    return apiFetch<Application>("/apps", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  listTemplates() {
    return apiFetch<Template[]>("/apps/templates");
  },
  createFromTemplate(slug: string, input: { name: string; serverId: string; environmentId?: string }) {
    return apiFetch<Application>(`/apps/templates/${slug}`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  deployApp(id: string, opts?: { noCache?: boolean }) {
    return apiFetch<Deployment>(`/apps/${id}/deploy`, { method: "POST", body: JSON.stringify(opts ?? {}) });
  },
  listVolumeBackups(appId: string) {
    return apiFetch<VolumeBackup[]>(`/apps/${appId}/volume-backups`);
  },
  volumeBackupNow(appId: string) {
    return apiFetch<VolumeBackup[]>(`/apps/${appId}/volume-backups`, { method: "POST" });
  },
  restoreVolumeBackup(appId: string, id: string) {
    return apiFetch<{ ok: true }>(`/apps/${appId}/volume-backups/${id}/restore`, { method: "POST" });
  },
  deleteVolumeBackup(appId: string, id: string) {
    return apiFetch<{ ok: true }>(`/apps/${appId}/volume-backups/${id}`, { method: "DELETE" });
  },
  setVolumeBackupConfig(appId: string, cfg: { enabled: boolean; intervalHours?: number | null; retention?: number; destinationId?: string | null }) {
    return apiFetch<Application>(`/apps/${appId}/volume-backups/config`, { method: "PUT", body: JSON.stringify(cfg) });
  },
  stopApp(id: string) {
    return apiFetch<{ ok: true }>(`/apps/${id}/stop`, { method: "POST" });
  },
  startApp(id: string) {
    return apiFetch<{ ok: true }>(`/apps/${id}/start`, { method: "POST" });
  },
  restartApp(id: string) {
    return apiFetch<{ ok: true }>(`/apps/${id}/restart`, { method: "POST" });
  },
  deleteApp(id: string) {
    return apiFetch<{ ok: true }>(`/apps/${id}`, { method: "DELETE" });
  },
  getDeployments(id: string) {
    return apiFetch<Deployment[]>(`/apps/${id}/deployments`);
  },
  rollbackApp(id: string, deploymentId: string) {
    return apiFetch<Deployment>(`/apps/${id}/rollback/${deploymentId}`, { method: "POST" });
  },
  analyzeDeployment(id: string, deploymentId: string) {
    return apiFetch<{ analysis: string }>(`/apps/${id}/deployments/${deploymentId}/analyze`, { method: "POST" });
  },
  getAppLogs(id: string, tail?: number) {
    return apiFetch<{ output: string }>(`/apps/${id}/logs${tail ? `?tail=${tail}` : ""}`);
  },
  listAppContainers(id: string) {
    return apiFetch<{ containers: { name: string; state: string }[] }>(`/apps/${id}/containers`);
  },
  renameApp(id: string, name: string) {
    return apiFetch<{ ok: true }>(`/apps/${id}/name`, { method: "PUT", body: JSON.stringify({ name }) });
  },
  regenerateWebhook(id: string) {
    return apiFetch<Application>(`/apps/${id}/webhook/regenerate`, {
      method: "POST",
    });
  },
  setAppTags(id: string, tags: string[]) {
    return apiFetch<{ ok: true }>(`/apps/${id}/tags`, {
      method: "PUT",
      body: JSON.stringify({ tags }),
    });
  },
  getAppPreviews(id: string) {
    return apiFetch<Application[]>(`/apps/${id}/previews`);
  },
  setPreviewEnabled(id: string, enabled: boolean) {
    return apiFetch<{ ok: true }>(`/apps/${id}/preview-config`, {
      method: "PUT",
      body: JSON.stringify({ enabled }),
    });
  },
  deletePreview(id: string, previewId: string) {
    return apiFetch<{ ok: true }>(`/apps/${id}/previews/${previewId}`, {
      method: "DELETE",
    });
  },
  getAppEnv(id: string) {
    return apiFetch<Record<string, string>>(`/apps/${id}/env`);
  },
  setAppEnv(id: string, env: Record<string, string>) {
    return apiFetch<{ ok: true }>(`/apps/${id}/env`, {
      method: "PUT",
      body: JSON.stringify({ env }),
    });
  },
  getAppBuildArgs(id: string) {
    return apiFetch<Record<string, string>>(`/apps/${id}/build-args`);
  },
  setAppBuildArgs(id: string, buildArgs: Record<string, string>) {
    return apiFetch<{ ok: true }>(`/apps/${id}/build-args`, {
      method: "PUT",
      body: JSON.stringify({ buildArgs }),
    });
  },
  setAppDockerOptions(id: string, dockerOptions: string | null) {
    return apiFetch<{ ok: true }>(`/apps/${id}/docker-options`, {
      method: "PUT",
      body: JSON.stringify({ dockerOptions }),
    });
  },
  setAppLimits(id: string, limits: { healthCmd?: string | null; memoryMb?: number | null; cpus?: number | null; deployTimeoutSec?: number | null }) {
    return apiFetch<{ ok: true }>(`/apps/${id}/limits`, {
      method: "PUT",
      body: JSON.stringify(limits),
    });
  },
  setDatabaseLimits(id: string, limits: { healthCmd?: string | null; memoryMb?: number | null; cpus?: number | null }) {
    return apiFetch<{ ok: true }>(`/databases/${id}/limits`, {
      method: "PUT",
      body: JSON.stringify(limits),
    });
  },
  setDatabasePort(id: string, hostPort: number | null) {
    return apiFetch<{ ok: true }>(`/databases/${id}/port`, {
      method: "PUT",
      body: JSON.stringify({ hostPort }),
    });
  },
  renameDatabase(id: string, name: string) {
    return apiFetch<{ ok: true }>(`/databases/${id}/name`, { method: "PUT", body: JSON.stringify({ name }) });
  },
  importDatabaseFromUrl(id: string, body: { url: string; gzip: boolean; encrypted: boolean; encryptionKey?: string }) {
    return apiFetch<{ ok: true }>(`/databases/${id}/backups/import-from-url`, { method: "POST", body: JSON.stringify(body) });
  },
  setAppVolumes(id: string, volumes: AppVolume[]) {
    return apiFetch<{ ok: true }>(`/apps/${id}/volumes`, {
      method: "PUT",
      body: JSON.stringify({ volumes }),
    });
  },
  listAppTasks(id: string) {
    return apiFetch<ScheduledTask[]>(`/apps/${id}/tasks`);
  },
  createAppTask(id: string, task: { name: string; schedule: string; command: string; enabled?: boolean }) {
    return apiFetch<ScheduledTask>(`/apps/${id}/tasks`, { method: "POST", body: JSON.stringify(task) });
  },
  updateAppTask(id: string, taskId: string, patch: { name?: string; schedule?: string; command?: string; enabled?: boolean }) {
    return apiFetch<ScheduledTask>(`/apps/${id}/tasks/${taskId}`, { method: "PUT", body: JSON.stringify(patch) });
  },
  deleteAppTask(id: string, taskId: string) {
    return apiFetch<{ ok: true }>(`/apps/${id}/tasks/${taskId}`, { method: "DELETE" });
  },
  setAppCredentials(
    id: string,
    creds: { gitToken?: string | null; registry?: { url?: string; user: string; token: string } | null },
  ) {
    return apiFetch<{ ok: true }>(`/apps/${id}/credentials`, {
      method: "PUT",
      body: JSON.stringify(creds),
    });
  },
  setAppEnvironment(id: string, environmentId: string | null) {
    return apiFetch<{ ok: true }>(`/apps/${id}/environment`, {
      method: "PUT",
      body: JSON.stringify({ environmentId }),
    });
  },
  listDomains() {
    return apiFetch<DomainView[]>("/apps/domains");
  },
  setAppDomainOptions(
    id: string,
    opts: { domainRedirect?: "www" | "root" | null; securityHeaders?: boolean; forwardAuth?: string | null },
  ) {
    return apiFetch<{ ok: true }>(`/apps/${id}/domain-options`, {
      method: "PUT",
      body: JSON.stringify(opts),
    });
  },
  setDatabaseTags(id: string, tags: string[]) {
    return apiFetch<{ ok: true }>(`/databases/${id}/tags`, {
      method: "PUT",
      body: JSON.stringify({ tags }),
    });
  },
  setDatabaseEnvironment(id: string, environmentId: string | null) {
    return apiFetch<{ ok: true }>(`/databases/${id}/environment`, {
      method: "PUT",
      body: JSON.stringify({ environmentId }),
    });
  },

  // ── projects / environments ──
  listProjects() {
    return apiFetch<Project[]>("/projects");
  },
  getProject(id: string) {
    return apiFetch<Project>(`/projects/${id}`);
  },
  createProject(teamId: string, name: string) {
    return apiFetch<Project>("/projects", { method: "POST", body: JSON.stringify({ teamId, name }) });
  },
  renameProject(id: string, name: string) {
    return apiFetch<Project>(`/projects/${id}`, { method: "PUT", body: JSON.stringify({ name }) });
  },
  deleteProject(id: string) {
    return apiFetch<{ ok: true }>(`/projects/${id}`, { method: "DELETE" });
  },
  addEnvironment(projectId: string, name: string) {
    return apiFetch<Project>(`/projects/${projectId}/environments`, { method: "POST", body: JSON.stringify({ name }) });
  },
  deleteEnvironment(envId: string) {
    return apiFetch<{ ok: true }>(`/projects/environments/${envId}`, { method: "DELETE" });
  },

  // ── databases ──
  listDatabases() {
    return apiFetch<Database[]>("/databases");
  },
  getDatabase(id: string) {
    return apiFetch<Database>(`/databases/${id}`);
  },
  createDatabase(input: {
    name: string;
    serverId: string;
    engine: DbEngine;
    version?: string;
    hostPort?: number;
    environmentId?: string;
  }) {
    return apiFetch<Database>("/databases", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  provisionDatabase(id: string) {
    return apiFetch<Database>(`/databases/${id}/provision`, { method: "POST" });
  },
  stopDatabase(id: string) {
    return apiFetch<{ ok: true }>(`/databases/${id}/stop`, { method: "POST" });
  },
  deleteDatabase(id: string) {
    return apiFetch<{ ok: true }>(`/databases/${id}`, { method: "DELETE" });
  },

  // ── database backups ──
  listBackups(dbId: string) {
    return apiFetch<Backup[]>(`/databases/${dbId}/backups`);
  },
  backupNow(dbId: string) {
    return apiFetch<Backup>(`/databases/${dbId}/backups`, { method: "POST" });
  },
  restoreBackup(dbId: string, backupId: string) {
    return apiFetch<{ ok: true }>(`/databases/${dbId}/backups/${backupId}/restore`, { method: "POST" });
  },
  deleteBackup(dbId: string, backupId: string) {
    return apiFetch<{ ok: true }>(`/databases/${dbId}/backups/${backupId}`, { method: "DELETE" });
  },
  setBackupConfig(dbId: string, cfg: { enabled: boolean; intervalHours?: number; retention?: number; destinationId?: string | null }) {
    return apiFetch<{ ok: true }>(`/databases/${dbId}/backup-config`, {
      method: "PUT",
      body: JSON.stringify(cfg),
    });
  },

  // ── backup destinations ──
  listDestinations() {
    return apiFetch<BackupDestination[]>("/backup-destinations");
  },
  createDestination(input: {
    teamId: string;
    name: string;
    type: "S3";
    s3Bucket: string;
    s3Region?: string;
    s3Endpoint: string;
    s3AccessKey: string;
    s3SecretKey: string;
    s3Prefix?: string;
    encryptionEnabled?: boolean;
  }) {
    return apiFetch<BackupDestination>("/backup-destinations", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  deleteDestination(id: string) {
    return apiFetch<{ ok: true }>(`/backup-destinations/${id}`, { method: "DELETE" });
  },

  // ── API tokens ──
  listApiTokens() {
    return apiFetch<ApiToken[]>("/api-tokens");
  },
  createApiToken(name: string, expiresInDays?: number) {
    return apiFetch<{ token: string; view: ApiToken }>("/api-tokens", {
      method: "POST",
      body: JSON.stringify({ name, expiresInDays }),
    });
  },
  deleteApiToken(id: string) {
    return apiFetch<{ ok: true }>(`/api-tokens/${id}`, { method: "DELETE" });
  },

  // ── shared variables (team-wide env) ──
  listSharedVars(teamId: string) {
    return apiFetch<SharedVariable[]>(`/shared-variables?teamId=${teamId}`);
  },
  setSharedVar(teamId: string, key: string, value: string) {
    return apiFetch<SharedVariable>("/shared-variables", {
      method: "POST",
      body: JSON.stringify({ teamId, key, value }),
    });
  },
  deleteSharedVar(id: string) {
    return apiFetch<{ ok: true }>(`/shared-variables/${id}`, { method: "DELETE" });
  },
};
