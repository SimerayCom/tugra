import type {
  ApiToken,
  ApiTokenScope,
  PlacementConstraint,
  InstanceStatus,
  InstanceUpdateApply,
  InstanceUpdateStatus,
  OwnerInstanceSettings,
  OidcConfig,
  LicenseStatus,
  Cluster,
  ClusterDetail,
  AppClusterStatus,
  SwarmView,
  SavedView,
  Application,
  AppVolume,
  BulkOperation,
  Backup,
  Restore,
  BackupDestination,
  AuditPage,
  Channel,
  Delivery,
  Database,
  GitSource,
  SourceRepo,
  Registry,
  VolumeBackup,
  DbEngine,
  Deployment,
  DomainView,
  Heartbeat,
  MetricsSample,
  MetricsRange,
  AppContainerMetrics,
  ServerContainers,
  DiscoveredContainer,
  CloudCredential,
  Monitor,
  LogDrain,
  MyInvitation,
  InvitationPreview,
  PatchInfo,
  ProxyStatus,
  PublicUser,
  Project,
  Role,
  ScheduledTask,
  ServerStatus,
  ServerView,
  SharedVariable,
  Team,
  TeamInvitation,
  TeamMember,
  TeamRole,
  Template,
  TemplateManifest,
  TokenPair,
  TunnelView,
} from "./types";

// Same-origin path the SPA calls; next.config rewrites proxy it to the hub, so the httpOnly session
// cookie rides along (SameSite=Lax, no CORS). Auth tokens live in cookies now, never JS/localStorage.
// The hub serves its REST API under /api/v1 (versioned); this constant is the single place that base is
// set, so every api.* method + SSE/download caller follows automatically.
export const API_BASE = "/api/v1";

// The hub's PUBLIC absolute origin — ONLY for URLs that hit the hub DIRECTLY (not through the SPA's
// same-origin "/api" proxy): the terminal WebSocket upgrade and webhook URLs shown to paste externally.
// Resolution: (1) a baked NEXT_PUBLIC_API_URL wins (explicit override; build-from-source installs set it);
// (2) otherwise the current browser origin at runtime — so the PUBLISHED image (which bakes no URL) works
// out of the box for a single-origin reverse-proxy (--domain) deployment where /terminal and /webhooks are
// routed to the hub on the same origin; (3) a dev/SSR fallback.
export function hubPublicUrl(): string {
  const baked = process.env.NEXT_PUBLIC_API_URL;
  if (baked) return baked;
  if (typeof window !== "undefined" && window.location?.origin) return window.location.origin;
  return "http://localhost:3000";
}

const TG_CSRF = "tg_csrf";
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Read a JS-readable cookie by name (used for the double-submit CSRF token). */
function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  for (const part of document.cookie.split("; ")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Try a cookie-based refresh; the hub reads tg_refresh from the cookie and rotates the session. */
async function tryRefresh(): Promise<boolean> {
  const headers = new Headers({ "content-type": "application/json" });
  const csrf = readCookie(TG_CSRF);
  if (csrf) headers.set("x-csrf-token", csrf);
  const res = await fetch(`${API_BASE}/auth/refresh`, {
    method: "POST",
    headers,
    credentials: "include",
    body: "{}",
  });
  return res.ok;
}

export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
  retry = true,
): Promise<T> {
  const method = String(init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  // Double-submit CSRF: echo the JS-readable tg_csrf cookie on state-changing requests.
  if (MUTATING.has(method)) {
    const csrf = readCookie(TG_CSRF);
    if (csrf) headers.set("x-csrf-token", csrf);
  }

  const res = await fetch(`${API_BASE}${path}`, { ...init, headers, credentials: "include" });

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
    // The hub sets the httpOnly session cookies on the response; we only need the user back.
    const out = await apiFetch<{ user: PublicUser; tokens: TokenPair }>(
      "/auth/register",
      { method: "POST", body: JSON.stringify({ email, password, name }) },
      false,
    );
    return out.user;
  },

  // Public + no refresh-retry: request a reset link (always resolves — no account enumeration).
  forgotPassword(email: string) {
    return apiFetch<{ ok: true }>("/auth/forgot-password", { method: "POST", body: JSON.stringify({ email }) }, false);
  },
  resetPassword(token: string, newPassword: string) {
    return apiFetch<{ ok: true }>("/auth/reset-password", { method: "POST", body: JSON.stringify({ token, newPassword }) }, false);
  },
  // Public: confirm an emailed verification link (clicked possibly on another device / logged out).
  verifyEmail(token: string) {
    return apiFetch<{ ok: true }>("/auth/verify-email", { method: "POST", body: JSON.stringify({ token }) }, false);
  },
  // Authed: re-send the current user's verification email (no-op once verified).
  resendVerification() {
    return apiFetch<{ ok: true }>("/auth/resend-verification", { method: "POST" });
  },

  async login(email: string, password: string, totp?: string) {
    // On success the hub sets the session cookies; the 2FA-required step sets none.
    return apiFetch<{ tokens: TokenPair } | { twoFaRequired: true }>(
      "/auth/login",
      { method: "POST", body: JSON.stringify({ email, password, totp }) },
      false,
    );
  },

  me() {
    return apiFetch<PublicUser>("/auth/me");
  },
  // Public: onboarding status (no auth). retry=false so a logged-out/uninitialized visitor never triggers
  // the 401→cookie-refresh cycle. Drives the welcome gate for a fresh install.
  getInstanceStatus() {
    return apiFetch<InstanceStatus>("/instance/status", {}, false);
  },
  // Owner-only instance settings (session-guarded on the hub).
  getInstanceSettings() {
    return apiFetch<OwnerInstanceSettings>("/instance/settings");
  },
  updateInstanceSettings(patch: {
    apiEnabled?: boolean;
    apiAllowedIps?: string[];
    publicUrl?: string | null;
    acmeEmail?: string | null;
  }) {
    return apiFetch<OwnerInstanceSettings>("/instance/settings", { method: "PATCH", body: JSON.stringify(patch) });
  },
  // Owner-only signed-license status + activation (not edition-gated: Community can upgrade). Write-only token.
  getLicense() {
    return apiFetch<LicenseStatus>("/instance/license");
  },
  activateLicense(token: string) {
    return apiFetch<LicenseStatus>("/instance/license", { method: "PATCH", body: JSON.stringify({ token }) });
  },
  // Owner-only OIDC (SSO) config — Pro edition (the hub 403s below Pro). The client secret is write-only.
  getOidcConfig() {
    return apiFetch<OidcConfig>("/instance/oidc");
  },
  updateOidcConfig(patch: {
    oidcEnabled?: boolean;
    oidcIssuer?: string | null;
    oidcClientId?: string | null;
    oidcClientSecret?: string;
    oidcAllowedDomains?: string[];
  }) {
    return apiFetch<OidcConfig>("/instance/oidc", { method: "PATCH", body: JSON.stringify(patch) });
  },
  // Owner-only self-update status + preferences (session-guarded on the hub).
  getInstanceUpdate() {
    return apiFetch<InstanceUpdateStatus>("/instance/update");
  },
  updateInstanceUpdate(patch: { autoUpdate?: boolean; updateChannel?: string }) {
    return apiFetch<InstanceUpdateStatus>("/instance/update", { method: "PATCH", body: JSON.stringify(patch) });
  },
  // Trigger a manual re-check of the signed release manifest now.
  checkInstanceUpdate() {
    return apiFetch<InstanceUpdateStatus>("/instance/update/check", { method: "POST" });
  },
  // Start the updater (owner). Throws ApiError 409 when an update is already in progress.
  applyInstanceUpdate() {
    return apiFetch<InstanceUpdateApply>("/instance/update", { method: "POST" });
  },
  updateProfile(input: { name?: string; email?: string; uiMode?: "fleet" | "home"; currentPassword?: string }) {
    // An email change is deferred (confirmed via a link to the new address) and requires the current
    // password — the response keeps the OLD email until the new one is confirmed.
    return apiFetch<PublicUser>("/auth/me", { method: "PATCH", body: JSON.stringify(input) });
  },
  changePassword(input: { currentPassword: string; newPassword: string }) {
    // The server revokes every other session and refreshes THIS device's cookies in place, so the
    // current session survives the password change (other devices are signed out).
    return apiFetch<{ ok: true; tokens: TokenPair }>("/auth/change-password", { method: "POST", body: JSON.stringify(input) });
  },

  async logout() {
    // The hub reads the refresh cookie, revokes it, and clears all session cookies.
    await apiFetch("/auth/logout", { method: "POST" }, false).catch(() => undefined);
  },

  /** Revoke every session for the current user (all devices); the hub clears this one's cookies. */
  async logoutAll() {
    await apiFetch<{ ok: true }>("/auth/logout-all", { method: "POST" }).catch(() => undefined);
  },

  /** Mint a short-lived terminal ticket (browser can't read the httpOnly access cookie for the WS). */
  terminalTicket() {
    return apiFetch<{ ticket: string }>("/terminal/ticket", { method: "POST" });
  },

  setup2fa() {
    return apiFetch<{ otpauthUrl: string; qrDataUrl: string }>(
      "/auth/2fa/setup",
      { method: "POST" },
    );
  },

  enable2fa(token: string) {
    // Returns the 10 one-time recovery codes (shown once) — the caller MUST surface them.
    return apiFetch<{ recoveryCodes: string[] }>("/auth/2fa/enable", {
      method: "POST",
      body: JSON.stringify({ token }),
    });
  },

  disable2fa(password: string, code: string) {
    return apiFetch<{ ok: true }>("/auth/2fa/disable", { method: "POST", body: JSON.stringify({ password, code }) });
  },

  regenerateRecoveryCodes(password: string, code: string) {
    return apiFetch<{ recoveryCodes: string[] }>("/auth/2fa/recovery-codes/regenerate", { method: "POST", body: JSON.stringify({ password, code }) });
  },

  recoveryCodesStatus() {
    return apiFetch<{ remaining: number }>("/auth/2fa/recovery-codes/status");
  },

  listTeams() {
    return apiFetch<Team[]>("/teams");
  },
  getTeam(id: string) {
    return apiFetch<Team>(`/teams/${id}`);
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
  // Assign a built-in role OR a custom team role (exactly one).
  setTeamMemberRole(id: string, userId: string, assignment: { role: Role } | { teamRoleId: string }) {
    return apiFetch<{ ok: true }>(`/teams/${id}/members/${userId}`, {
      method: "PUT",
      body: JSON.stringify(assignment),
    });
  },
  listTeamRoles(id: string) {
    return apiFetch<TeamRole[]>(`/teams/${id}/roles`);
  },
  createTeamRole(id: string, input: { name: string; permissions: string[] }) {
    return apiFetch<TeamRole>(`/teams/${id}/roles`, { method: "POST", body: JSON.stringify(input) });
  },
  updateTeamRole(id: string, roleId: string, input: { name?: string; permissions?: string[] }) {
    return apiFetch<TeamRole>(`/teams/${id}/roles/${roleId}`, { method: "PUT", body: JSON.stringify(input) });
  },
  deleteTeamRole(id: string, roleId: string) {
    return apiFetch<{ ok: true }>(`/teams/${id}/roles/${roleId}`, { method: "DELETE" });
  },
  removeTeamMember(id: string, userId: string) {
    return apiFetch<{ ok: true }>(`/teams/${id}/members/${userId}`, { method: "DELETE" });
  },
  setTeamMemberAccess(id: string, userId: string, input: { restrictedAccess: boolean; accessedProjects: string[] }) {
    return apiFetch<{ ok: true }>(`/teams/${id}/members/${userId}/access`, { method: "PATCH", body: JSON.stringify(input) });
  },
  myInvitations() {
    return apiFetch<MyInvitation[]>("/teams/invitations/mine");
  },
  // Public: preview an invitation by its token (no auth) — powers the /invite/[token] page.
  previewInvitation(token: string) {
    return apiFetch<InvitationPreview>(`/invitations/${encodeURIComponent(token)}`, {}, false);
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

  // Clusters (server groups) — team-scoped fleet organization + health rollup.
  listClusters(teamId?: string) {
    return apiFetch<Cluster[]>(`/clusters${teamId ? `?teamId=${encodeURIComponent(teamId)}` : ""}`);
  },
  getCluster(id: string) {
    return apiFetch<ClusterDetail>(`/clusters/${id}`);
  },
  createCluster(body: { teamId: string; name: string; description?: string }) {
    return apiFetch<Cluster>("/clusters", { method: "POST", body: JSON.stringify(body) });
  },
  updateCluster(id: string, body: { name?: string; description?: string | null }) {
    return apiFetch<ClusterDetail>(`/clusters/${id}`, { method: "PATCH", body: JSON.stringify(body) });
  },
  deleteCluster(id: string) {
    return apiFetch<void>(`/clusters/${id}`, { method: "DELETE" });
  },
  setClusterServers(id: string, serverIds: string[]) {
    return apiFetch<ClusterDetail>(`/clusters/${id}/servers`, { method: "PUT", body: JSON.stringify({ serverIds }) });
  },
  // Docker Swarm formation (Phase2): form the swarm, read live status, dissolve it.
  formSwarm(id: string, body: { managerServerId: string; advertiseAddr?: string }) {
    return apiFetch<SwarmView>(`/clusters/${id}/swarm`, { method: "POST", body: JSON.stringify(body) });
  },
  joinSwarmNode(id: string, body: { serverId: string; advertiseAddr?: string }) {
    return apiFetch<SwarmView>(`/clusters/${id}/swarm/nodes`, { method: "POST", body: JSON.stringify(body) });
  },
  getSwarmStatus(id: string) {
    return apiFetch<SwarmView>(`/clusters/${id}/swarm`);
  },
  dissolveSwarm(id: string) {
    return apiFetch<SwarmView>(`/clusters/${id}/swarm`, { method: "DELETE" });
  },
  leaveSwarmNode(clusterId: string, serverId: string) {
    return apiFetch<SwarmView>(`/clusters/${clusterId}/swarm/nodes/${serverId}`, { method: "DELETE" });
  },
  setNodeLabels(clusterId: string, nodeId: string, body: { add: Record<string, string>; remove: string[] }) {
    return apiFetch<SwarmView>(`/clusters/${clusterId}/swarm/nodes/${encodeURIComponent(nodeId)}/labels`, { method: "PUT", body: JSON.stringify(body) });
  },
  addManager(id: string, body: { serverId: string; acknowledgeEvenQuorum?: boolean }) {
    return apiFetch<SwarmView>(`/clusters/${id}/swarm/managers`, { method: "POST", body: JSON.stringify(body) });
  },
  removeManager(clusterId: string, serverId: string, opts?: { acknowledgeEvenQuorum?: boolean }) {
    const q = opts?.acknowledgeEvenQuorum ? "?acknowledgeEvenQuorum=true" : "";
    return apiFetch<SwarmView>(`/clusters/${clusterId}/swarm/managers/${serverId}${q}`, { method: "DELETE" });
  },

  getMetrics(id: string, limit = 60) {
    return apiFetch<MetricsSample[]>(`/servers/${id}/metrics?limit=${limit}`);
  },
  getServerMetricsRange(id: string, range: MetricsRange) {
    return apiFetch<MetricsSample[]>(`/servers/${id}/metrics?range=${range}`);
  },
  getAppContainerMetrics(id: string, range: MetricsRange) {
    return apiFetch<AppContainerMetrics>(`/apps/${id}/metrics/containers?range=${range}`);
  },
  getServerContainers(id: string) {
    return apiFetch<ServerContainers>(`/servers/${id}/metrics/containers`);
  },
  discoverContainers(id: string) {
    return apiFetch<{ containers: DiscoveredContainer[] }>(`/servers/${id}/discover`);
  },
  adoptContainer(
    id: string,
    input: { container: string; name: string; environmentId?: string; portIndex?: number; envKeys?: string[] },
  ) {
    return apiFetch<Application>(`/servers/${id}/adopt`, { method: "POST", body: JSON.stringify(input) });
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
  getTunnelStatus(id: string) {
    return apiFetch<TunnelView>(`/servers/${id}/tunnel`);
  },
  setupTunnel(id: string, input: { apiToken: string; cfAccountId: string; zoneName: string; wildcardDomain?: string }) {
    return apiFetch<TunnelView>(`/servers/${id}/tunnel`, { method: "POST", body: JSON.stringify(input) });
  },
  teardownTunnel(id: string) {
    return apiFetch<{ ok: true }>(`/servers/${id}/tunnel`, { method: "DELETE" });
  },
  setAppTunnel(appId: string, exposed: boolean) {
    return apiFetch<{ tunnelExposed: boolean }>(`/apps/${appId}/tunnel`, {
      method: "PUT",
      body: JSON.stringify({ exposed }),
    });
  },
  setServerTags(id: string, tags: string[]) {
    return apiFetch<{ ok: true }>(`/servers/${id}/tags`, {
      method: "PUT",
      body: JSON.stringify({ tags }),
    });
  },
  setServerCapabilities(id: string, capabilities: string[]) {
    return apiFetch<{ ok: true }>(`/servers/${id}/capabilities`, {
      method: "PUT",
      body: JSON.stringify({ capabilities }),
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
  setServerNetwork(
    id: string,
    cfg: {
      publicIp?: string | null;
      publicIpv6?: string | null;
      wildcardDomain?: string | null;
      magicSuffix?: string | null;
      certMode?: "http" | "le-dns" | "custom";
      dnsProvider?: string | null;
      dnsCreds?: Record<string, string> | null;
      customCertResolver?: string | null;
    },
  ) {
    return apiFetch<{ ok: true }>(`/servers/${id}/network`, {
      method: "PUT",
      body: JSON.stringify(cfg),
    });
  },
  bulkSetCleanupConfig(serverIds: string[], cfg: { enabled: boolean; intervalHours?: number; volumes?: boolean }) {
    return apiFetch<{ applied: string[]; skipped: string[] }>(`/fleet/cleanup-config`, {
      method: "POST",
      body: JSON.stringify({ serverIds, ...cfg }),
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
  deleteServer(id: string, opts?: { destroyVm?: boolean }) {
    return apiFetch<{ ok: true }>(`/servers/${id}${opts?.destroyVm ? "?destroyVm=true" : ""}`, { method: "DELETE" });
  },
  // Cloud provisioning + provider credentials
  listCloudCredentials() {
    return apiFetch<CloudCredential[]>("/cloud-credentials");
  },
  createCloudCredential(input: { teamId: string; name: string; provider: string; apiToken: string }) {
    return apiFetch<CloudCredential>("/cloud-credentials", { method: "POST", body: JSON.stringify(input) });
  },
  updateCloudCredential(id: string, input: { name?: string; apiToken?: string }) {
    return apiFetch<CloudCredential>(`/cloud-credentials/${id}`, { method: "PUT", body: JSON.stringify(input) });
  },
  testCloudCredential(id: string) {
    return apiFetch<{ ok: true }>(`/cloud-credentials/${id}/test`, { method: "POST" });
  },
  deleteCloudCredential(id: string) {
    return apiFetch<{ ok: true }>(`/cloud-credentials/${id}`, { method: "DELETE" });
  },
  provisionServer(input: { teamId: string; name: string; cloudCredentialId: string; provider: "hetzner"; location: string; serverType: string; image?: string }) {
    return apiFetch<ServerView>("/servers/provision", { method: "POST", body: JSON.stringify(input) });
  },
  getServerInstall(id: string) {
    return apiFetch<{ status: ServerStatus; installCommand: string | null; expiresAt: string | null }>(
      `/servers/${id}/install`,
    );
  },
  reissueServerEnroll(id: string) {
    return apiFetch<{ installCommand: string; expiresAt: string }>(`/servers/${id}/reissue`, { method: "POST" });
  },

  // ── monitors ──
  listMonitors() {
    return apiFetch<Monitor[]>("/monitors");
  },
  bulkSetMonitorChannels(monitorIds: string[], channelIds: string[]) {
    return apiFetch<{ applied: string[]; skipped: string[] }>(`/monitors/channels/bulk`, {
      method: "POST",
      body: JSON.stringify({ monitorIds, channelIds }),
    });
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
  /** The canonical subscribable event ids — the single source the UI renders from (no drift). */
  listChannelEvents() {
    return apiFetch<{ events: string[] }>("/channels/events");
  },
  /** Recent delivery attempts for a channel (newest first, up to 100) — any team member may read. */
  listDeliveries(channelId: string) {
    return apiFetch<Delivery[]>(`/channels/${channelId}/deliveries`);
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
  listAudit(teamId?: string, cursor?: string) {
    const params = new URLSearchParams();
    if (teamId) params.set("teamId", teamId);
    if (cursor) params.set("cursor", cursor);
    const qs = params.toString();
    return apiFetch<AuditPage>(`/audit${qs ? `?${qs}` : ""}`);
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

  // ── Container registries ──────────────────────────────────────────
  listRegistries() {
    return apiFetch<Registry[]>("/registries");
  },
  createRegistry(input: { name: string; teamId: string; type: string; url?: string | null; username: string; password: string; imagePrefix?: string | null }) {
    return apiFetch<Registry>("/registries", { method: "POST", body: JSON.stringify(input) });
  },
  updateRegistry(id: string, input: { name?: string; type?: string; url?: string | null; username?: string; password?: string; imagePrefix?: string | null }) {
    return apiFetch<Registry>(`/registries/${id}`, { method: "PUT", body: JSON.stringify(input) });
  },
  testRegistry(id: string) {
    return apiFetch<{ ok: true }>(`/registries/${id}/test`, { method: "POST" });
  },
  deleteRegistry(id: string) {
    return apiFetch<{ ok: true }>(`/registries/${id}`, { method: "DELETE" });
  },
  setAppBuildConfig(id: string, cfg: { registryId?: string | null; pushToRegistry?: boolean; buildServerId?: string | null }) {
    return apiFetch<{ ok: true }>(`/apps/${id}/build-config`, { method: "PUT", body: JSON.stringify(cfg) });
  },
  setAppDeploySettings(id: string, cfg: { deployStrategy?: "ROLLING" | "RECREATE"; rollbackOnFailure?: boolean }) {
    return apiFetch<{ ok: true }>(`/apps/${id}/deploy-settings`, { method: "PUT", body: JSON.stringify(cfg) });
  },
  setAppClusterConfig(id: string, cfg: { clusterId?: string | null; replicas?: number | null }) {
    return apiFetch<{ ok: true }>(`/apps/${id}/cluster-config`, { method: "PUT", body: JSON.stringify(cfg) });
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
    deploy?: boolean;
  }) {
    return apiFetch<Application>("/apps", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  listTemplates() {
    return apiFetch<Template[]>("/apps/templates");
  },
  getTemplateManifest(slug: string, serverId?: string) {
    const qs = serverId ? `?serverId=${encodeURIComponent(serverId)}` : "";
    return apiFetch<TemplateManifest>(`/apps/templates/${slug}${qs}`);
  },
  createFromTemplate(
    slug: string,
    input: {
      name: string;
      serverId: string;
      environmentId?: string;
      deploy?: boolean;
      fields?: Record<string, string>;
      composeOverride?: string;
      envOverride?: Record<string, string>;
    },
  ) {
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
  importVolumeFromUrl(appId: string, body: { volumeName: string; url: string; gzip: boolean; encrypted: boolean; encryptionKey?: string }) {
    return apiFetch<{ ok: true }>(`/apps/${appId}/volume-backups/import-from-url`, { method: "POST", body: JSON.stringify(body) });
  },
  exportVolumeBackupUrl(appId: string, id: string, expireHours?: number) {
    return apiFetch<{ url: string; expiresAt: string }>(`/apps/${appId}/volume-backups/${id}/export-url`, {
      method: "POST",
      body: JSON.stringify(expireHours ? { expireHours } : {}),
    });
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
  getAppClusterStatus(id: string) {
    return apiFetch<AppClusterStatus>(`/apps/${id}/cluster-status`);
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
  setAppPlacement(id: string, body: { constraints: PlacementConstraint[]; spreadLabelKey: string | null }) {
    return apiFetch<{ ok: boolean }>(`/apps/${id}/placement`, { method: "PUT", body: JSON.stringify(body) });
  },
  setAppLimits(id: string, limits: { memoryMb?: number | null; cpus?: number | null; reserveMemoryMb?: number | null; reserveCpus?: number | null; gpus?: string | null; deployTimeoutSec?: number | null }) {
    return apiFetch<{ ok: true }>(`/apps/${id}/limits`, {
      method: "PUT",
      body: JSON.stringify(limits),
    });
  },
  setAppHealthCheck(
    id: string,
    hc: { type?: string | null; path?: string | null; port?: number | null; command?: string | null },
  ) {
    return apiFetch<{ ok: true }>(`/apps/${id}/health-check`, {
      method: "PUT",
      body: JSON.stringify(hc),
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
  setAppEnvironment(id: string, environmentId: string) {
    return apiFetch<{ ok: true }>(`/apps/${id}/environment`, {
      method: "PUT",
      body: JSON.stringify({ environmentId }),
    });
  },
  listDomains() {
    return apiFetch<DomainView[]>("/apps/domains");
  },
  setAppDomain(id: string, domain: string | null) {
    return apiFetch<{ ok: true }>(`/apps/${id}/domain`, {
      method: "PUT",
      body: JSON.stringify({ domain }),
    });
  },
  exposeApp(id: string, cfg: { mode: "magic" | "port" | "none" | "custom"; domain?: string }) {
    return apiFetch<Application>(`/apps/${id}/expose`, {
      method: "PUT",
      body: JSON.stringify(cfg),
    });
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
  setDatabaseEnvironment(id: string, environmentId: string) {
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
  listRestores(dbId: string) {
    return apiFetch<Restore[]>(`/databases/${dbId}/restores`);
  },
  backupNow(dbId: string) {
    return apiFetch<Backup>(`/databases/${dbId}/backups`, { method: "POST" });
  },
  restoreBackup(dbId: string, backupId: string) {
    return apiFetch<{ ok: true }>(`/databases/${dbId}/backups/${backupId}/restore`, { method: "POST" });
  },
  restoreBackupTo(sourceId: string, backupId: string, targetId: string) {
    return apiFetch<{ ok: true }>(`/databases/${sourceId}/backups/${backupId}/restore-to/${targetId}`, { method: "POST" });
  },
  deleteBackup(dbId: string, backupId: string) {
    return apiFetch<{ ok: true }>(`/databases/${dbId}/backups/${backupId}`, { method: "DELETE" });
  },
  exportDatabaseBackupUrl(dbId: string, backupId: string, expireHours?: number) {
    return apiFetch<{ url: string; expiresAt: string }>(`/databases/${dbId}/backups/${backupId}/export-url`, {
      method: "POST",
      body: JSON.stringify(expireHours ? { expireHours } : {}),
    });
  },
  setBackupConfig(dbId: string, cfg: { enabled: boolean; intervalHours?: number; retention?: number; destinationId?: string | null }) {
    return apiFetch<{ ok: true }>(`/databases/${dbId}/backup-config`, {
      method: "PUT",
      body: JSON.stringify(cfg),
    });
  },
  bulkSetBackupConfig(databaseIds: string[], cfg: { enabled: boolean; intervalHours?: number; retention?: number }) {
    return apiFetch<{ applied: string[]; skipped: string[] }>(`/fleet/backup-config`, {
      method: "POST",
      body: JSON.stringify({ databaseIds, ...cfg }),
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
  testDestination(id: string) {
    return apiFetch<{ ok: boolean; message: string }>(`/backup-destinations/${id}/test`, { method: "POST" });
  },

  // ── API tokens ──
  listSavedViews() {
    return apiFetch<SavedView[]>("/saved-views");
  },
  createSavedView(input: { name: string; status: SavedView["status"]; tags: string[]; teamId?: string }) {
    return apiFetch<SavedView>("/saved-views", { method: "POST", body: JSON.stringify(input) });
  },
  deleteSavedView(id: string) {
    return apiFetch<{ ok: true }>(`/saved-views/${id}`, { method: "DELETE" });
  },
  listApiTokens() {
    return apiFetch<ApiToken[]>("/api-tokens");
  },
  createApiToken(name: string, scopes: ApiTokenScope[], expiresInDays?: number) {
    return apiFetch<{ token: string; view: ApiToken }>("/api-tokens", {
      method: "POST",
      body: JSON.stringify({ name, scopes, expiresInDays }),
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
