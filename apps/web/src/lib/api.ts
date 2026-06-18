import type {
  ApiToken,
  Application,
  BulkOperation,
  Backup,
  BackupDestination,
  Channel,
  Database,
  DbEngine,
  Deployment,
  Heartbeat,
  MetricsSample,
  Monitor,
  PublicUser,
  ServerView,
  SharedVariable,
  Team,
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
  }) {
    return apiFetch<Monitor>("/monitors", {
      method: "POST",
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
  }) {
    return apiFetch<Channel>("/channels", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  testChannel(id: string) {
    return apiFetch<{ ok: true }>(`/channels/${id}/test`, { method: "POST" });
  },
  deleteChannel(id: string) {
    return apiFetch<{ ok: true }>(`/channels/${id}`, { method: "DELETE" });
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
    buildType?: "NIXPACKS" | "DOCKERFILE";
    composeFile?: string;
    hostPort?: number;
    containerPort?: number;
    domain?: string;
    env?: Record<string, string>;
  }) {
    return apiFetch<Application>("/apps", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  deployApp(id: string) {
    return apiFetch<Deployment>(`/apps/${id}/deploy`, { method: "POST" });
  },
  stopApp(id: string) {
    return apiFetch<{ ok: true }>(`/apps/${id}/stop`, { method: "POST" });
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
  regenerateWebhook(id: string) {
    return apiFetch<Application>(`/apps/${id}/webhook/regenerate`, {
      method: "POST",
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
  setAppLimits(id: string, limits: { healthCmd?: string | null; memoryMb?: number | null; cpus?: number | null }) {
    return apiFetch<{ ok: true }>(`/apps/${id}/limits`, {
      method: "PUT",
      body: JSON.stringify(limits),
    });
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
