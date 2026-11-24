import { HUB_UNREACHABLE_CODE, hubUnreachableMessage, isHubDownStatus, isNetworkFailure, reportHubDown } from "./hub-connection";
import type {
  RebootPreview,
  RebootRequest,
  RebootStatus,
  RebootView,
  AppMove,
  AppMovePhase,
  MoveAcks,
  MovePreflightResult,
  ApiToken,
  AppLabelsView,
  ApiTokenScope,
  PlacementConstraint,
  InstanceStatus,
  InstanceUpdateApply,
  InstanceUpdateStatus,
  InstanceVersionSummary,
  TelemetryStatus,
  Branding,
  PanelTlsStatus,
  PanelDomainStatus,
  OwnerInstanceSettings,
  OidcConfig,
  MailSettings,
  MailProvider,
  LicenseStatus,
  Cluster,
  ClusterDetail,
  AppClusterStatus,
  SwarmView,
  IngressView,
  SavedView,
  Application,
  ImageUpdate,
  ComposePreviewResult,
  BuildType,
  SourceCommitMode,
  AppConfigMount,
  AppVolume,
  HostMount,
  FileListing,
  BulkOperation,
  Backup,
  BackupUsage,
  Restore,
  BackupDestination,
  CreatedDestination,
  DestinationTestResult,
  VolumeBackupConfig,
  VolumeBackupPolicy,
  SchedulePreview,
  SealedKeyExport,
  HubBackupView,
  HubBackupItem,
  AuditPage,
  Channel,
  Delivery,
  Database,
  DatabaseLinkView,
  SecretProvider,
  SecretRefView,
  GitSource,
  SourceRepo,
  SourceBranch,
  Registry,
  VolumeBackup,
  DbEngine,
  Deployment,
  DomainView,
  Heartbeat,
  MetricsSample,
  FleetLatestRow,
  MetricsRange,
  FleetTrendRow,
  HottestContainerRow,
  AppContainerMetrics,
  ServerContainers,
  HostContainers,
  AppRuntimeState,
  DiscoveredContainer,
  CloudCredential,
  OobActionResult,
  OobCandidate,
  OobConsoleResult,
  OobPowerAction,
  OobRescueResult,
  OobStatus,
  DnsCredential,
  DnsAutoSetupResult,
  DnsManualRecords,
  Monitor,
  LogDrain,
  LogDrainInput,
  AppDrainSummary,
  MyInvitation,
  InvitationPreview,
  PatchInfo,
  FleetPatchCheckResult,
  FleetPatchApplyResult,
  AgentUpdateResponse,
  ProxyStatus,
  TrafficSummary,
  TrafficPaths,
  TrafficCountries,
  TrafficBreakdown,
  TrafficBreakdownDim,
  TrafficDomainRow,
  TrafficAnalyticsState,
  PublicUser,
  Project,
  Role,
  ScheduledTask,
  ScheduledTaskRun,
  ServerStatus,
  ServerView,
  SharedVariable,
  Team,
  TeamInvitation,
  TeamMember,
  TeamRole,
  ImportAck,
  ObjectMigrationView,
  CreateObjectMigrationInput,
  StartObjectMigrationInput,
  ImportGitLinksView,
  ImportRelinkResult,
  ImportPlan,
  ImportServiceChoice,
  ImportServicePreview,
  ImportMappingDoc,
  ImportResolved,
  ImportStoredMapping,
  ImportRemoteKind,
  ImportSession,
  ImportEgressIp,
  ImportOperation,
  MigrateCommand,
  MintedMigrationToken,
  OpVolumes,
  VxDiskVerdict,
  ImportRemapPlan,
  ImportRemapResult,
  Template,
  DiskUsage,
  GpuReport,
  TemplateManifest,
  TokenPair,
  TunnelView,
  PitrStatus,
  PitrWindow,
  Rollout,
  RolloutCreateInput,
  RolloutPlan,
  SecretsKeyStatus,
  DeploymentDetail,
  MigrationRunView,
  MigrationRunSummary,
  MigrationRunStatus,
  MigrationRunStepKey,
  MigrationRunEventsPage,
  MigrationRunCreateInput,
  MigrationRunInputsRequest,
  MigrationRunApproveInput,
  MigrationRunCommandKind,
  MigrationRunCommandResult,
  MigrationRunSafetyHints,
  MigrationRunReport,
} from "./types";

// Same-origin path the SPA calls; next.config rewrites proxy it to the hub, so the httpOnly session
// cookie rides along (SameSite=Lax, no CORS). Auth tokens live in cookies now, never JS/localStorage.
// The hub serves its REST API under /api/v1 (versioned); this constant is the single place that base is
// set, so every api.* method + SSE/download caller follows automatically.
export const API_BASE = "/api/v1";

/** Same-origin URL of a run's Markdown report (a plain download link; the session cookie rides along). */
export function migrationRunReportMdUrl(id: string): string {
  return `${API_BASE}/migration-runs/${encodeURIComponent(id)}/report?format=md`;
}

/** Same-origin URL for an app's custom icon, for an <img> tag (the session cookie rides along). `v` is the
 *  app's iconUpdatedAt — it cache-busts the image when the icon changes. Returns null when there is no icon. */
export function appIconUrl(id: string, iconUpdatedAt: string | null): string | null {
  if (!iconUpdatedAt) return null;
  return `${API_BASE}/apps/${id}/icon?v=${encodeURIComponent(iconUpdatedAt)}`;
}

export function projectIconUrl(id: string, iconUpdatedAt: string | null): string | null {
  if (!iconUpdatedAt) return null;
  return `${API_BASE}/projects/${id}/icon?v=${encodeURIComponent(iconUpdatedAt)}`;
}

export function teamIconUrl(id: string, iconUpdatedAt: string | null | undefined): string | null {
  if (!iconUpdatedAt) return null;
  return `${API_BASE}/teams/${id}/icon?v=${encodeURIComponent(iconUpdatedAt)}`;
}

export function databaseIconUrl(id: string, iconUpdatedAt: string | null): string | null {
  if (!iconUpdatedAt) return null;
  return `${API_BASE}/databases/${id}/icon?v=${encodeURIComponent(iconUpdatedAt)}`;
}

// The hub's PUBLIC absolute origin — ONLY for URLs that hit the hub DIRECTLY (not through the SPA's
// same-origin "/api" proxy): the terminal WebSocket upgrade and webhook URLs shown to paste externally.
// Resolution: (1) a baked NEXT_PUBLIC_API_URL wins (explicit override; build-from-source installs set it);
// (2) otherwise the hub's own HUB_PUBLIC_URL, read from the public GET /instance/status (hubPublicUrl) and
// cached — in the two-port quick start window.location.origin is the WEB port, not the hub, so it can't be
// trusted; (3) window.location.origin only when the hub reports no public URL (single-origin reverse-proxy
// deployments); (4) a dev/SSR fallback.
let cachedHubUrl: string | null = null;
let hubUrlPromise: Promise<string | null> | null = null;

function trimUrl(u: string): string {
  return u.replace(/\/+$/, "");
}

/** Fetch (once, memoized) the hub's public URL from /instance/status. Resolves null when unknown. */
export function ensureHubPublicUrl(): Promise<string | null> {
  if (process.env.NEXT_PUBLIC_API_URL) return Promise.resolve(process.env.NEXT_PUBLIC_API_URL);
  if (cachedHubUrl) return Promise.resolve(cachedHubUrl);
  if (!hubUrlPromise) {
    hubUrlPromise = fetch(`${API_BASE}/instance/status`, { credentials: "include" })
      .then(async (res) => {
        if (!res.ok) return null;
        return rememberHubUrl(((await res.json()) as { hubPublicUrl?: string })?.hubPublicUrl);
      })
      .catch(() => null)
      .then((v) => {
        if (!v) hubUrlPromise = null; // allow a later retry after a failure/empty answer
        return v;
      });
  }
  return hubUrlPromise;
}

function rememberHubUrl(u: unknown): string | null {
  if (typeof u === "string" && u.trim()) {
    cachedHubUrl = trimUrl(u.trim());
    return cachedHubUrl;
  }
  return null;
}

export function hubPublicUrl(): string {
  const baked = process.env.NEXT_PUBLIC_API_URL;
  if (baked) return baked;
  if (cachedHubUrl) return cachedHubUrl;
  if (typeof window !== "undefined") {
    void ensureHubPublicUrl(); // warm the cache for subsequent calls
    if (window.location?.origin) return window.location.origin;
  }
  return "http://localhost:3000";
}

export const TG_CSRF = "tg_csrf";
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Read a JS-readable cookie by name (used for the double-submit CSRF token). */
export function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  for (const part of document.cookie.split("; ")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}

/** Per-variable env flags as the hub returns them (full booleans; defaults: runtime on, the rest off). */
export type EnvFlagView = { buildTime: boolean; runtime: boolean; literal: boolean; multiline: boolean };
export type EnvFlagsResponse = {
  flags: Record<string, EnvFlagView>;
  applicable: { buildTime: boolean; literal: boolean };
  limits: { multilineValueBytes: number; multilineKeys: number; multilineTotalBytes: number; buildTotalBytes: number };
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The body's stable machine `code` (e.g. file-manager failures: exists, changed, datastore_running). Additive. */
    readonly code?: string,
    /** The raw JSON error body, for callers that need extra keys (capability, retryAfterSec, ...). Additive. */
    readonly data?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** Parse a failed response's JSON body into (message, code, data); falls back to the status text. */
export function parseApiErrorBody(body: unknown, fallback: string): { message: string; code?: string; data?: Record<string, unknown> } {
  const obj = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
  const m = obj?.message;
  const message = Array.isArray(m) ? m.join(", ") : typeof m === "string" ? m : fallback;
  return { message, code: typeof obj?.code === "string" ? obj.code : undefined, data: obj };
}

/**
 * Try a cookie-based refresh; the hub reads tg_refresh from the cookie and ROTATES the session (the old
 * refresh token is invalidated the moment it's used). The app fires many concurrent requests (fleet poll,
 * metric streams, parallel queries), so when the 15-min access token expires they all 401 at once.
 * Without single-flighting, each would POST /auth/refresh with the SAME cookie — the first rotates it, the
 * rest present the now-rotated token, and the hub's reuse-detection REVOKES the whole family, logging the
 * user out mid-session (the "it signs me out after ~15 min" symptom). Share ONE in-flight refresh so the
 * rotation can never race itself; the next 401 cycle starts a fresh one.
 */
let refreshing: Promise<boolean> | null = null;
export function tryRefresh(): Promise<boolean> {
  if (!refreshing) refreshing = doRefresh().finally(() => { refreshing = null; });
  return refreshing;
}
async function doRefresh(): Promise<boolean> {
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

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...init, headers, credentials: "include" });
  } catch (e) {
    // Network failure / timeout abort: the hub is restarting or unreachable. Say that instead of a raw
    // "Failed to fetch", and let the shell banner start watching for it to come back.
    if (!isNetworkFailure(e, init.signal)) throw e;
    reportHubDown();
    throw new ApiError(0, hubUnreachableMessage(), HUB_UNREACHABLE_CODE);
  }

  if (res.status === 401 && retry && (await tryRefresh())) {
    return apiFetch<T>(path, init, false);
  }
  if (isHubDownStatus(res.status) && !(res.headers.get("content-type") ?? "").includes("json")) {
    // A proxy 502/503/504 (HTML/empty body) means the upstream hub is down, typically mid-restart. A JSON body
    // is the hub's own deliberate error (e.g. an agent gateway timeout) and keeps its message.
    reportHubDown();
    throw new ApiError(res.status, hubUnreachableMessage(), HUB_UNREACHABLE_CODE);
  }
  if (!res.ok) {
    // HTTP/2 carries no reason phrase, so `res.statusText` is often "" (a 502 from the proxy while it restarts,
    // for example). Never surface an empty error: fall back to the status code.
    const fallback = res.statusText || `HTTP ${res.status}`;
    let parsed: ReturnType<typeof parseApiErrorBody> = { message: fallback };
    try {
      parsed = parseApiErrorBody(await res.json(), fallback);
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, parsed.message || fallback, parsed.code, parsed.data);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ── typed endpoints ────────────────────────────────────────────────

/** `?range=&teamId=&domain=&appId=&limit=` for the /traffic endpoints; unset/empty params are omitted. */
function trafficQuery(p: { range?: string; teamId?: string | null; domain?: string | null; appId?: string | null; limit?: number }): string {
  const q = new URLSearchParams();
  if (p.range) q.set("range", p.range);
  if (p.teamId) q.set("teamId", p.teamId);
  if (p.domain) q.set("domain", p.domain);
  if (p.appId) q.set("appId", p.appId);
  if (p.limit) q.set("limit", String(p.limit));
  const s = q.toString();
  return s ? `?${s}` : "";
}

// ── SSL/DNS cutover for imported apps (mirrors the hub's cutover.dto.ts; secret-free) ──
export type CutoverEntryState =
  | "PLANNED" | "CERT_PENDING" | "CERT_READY" | "READY" | "SWITCHING" | "SWITCHED" | "VERIFIED"
  | "VERIFY_FAILED" | "REVERTING" | "ROLLED_BACK" | "BLOCKED" | "EXCLUDED" | "CONFLICT";

export interface CutoverEntryView {
  id: string;
  applicationId: string;
  appName: string;
  hostname: string;
  role: string;
  state: CutoverEntryState | (string & {});
  blockReason: string | null;
  dnsMode: string;
  challenge: string;
  certState: string;
  certIssuer: string | null;
  certNotAfter: string | null;
  certError: string | null;
  dnsObserved: string;
  proxied: boolean | null;
  viaWildcard: boolean;
  sslMode: string | null;
  currentTtl: number | null;
  targetTtl: number | null;
  ttlWaitUntil: string | null;
  stateful: boolean;
  needsDeploy: boolean;
  warnings: string[];
  precheckAt: string | null;
  flippedAt: string | null;
  verifiedAt: string | null;
  finalizedAt: string | null;
  lastError: string | null;
  sourceName: string | null;
}

export interface CutoverServerView {
  serverId: string;
  name: string;
  publicIp: string | null;
  publicIpv6: string | null;
  proxyBind: string;
  acmeEmailOk: boolean;
  dnsReady: boolean;
  dnsProvider: string | null;
  dnsCredentialId: string | null;
  coverage: "verified" | "unverified" | "none";
  warnings: string[];
}

export interface CutoverRunView {
  id: string;
  status: string;
  batchesDone: number;
  total: number;
  startedAt: string;
  heartbeatAt: string;
  lastError: string | null;
}

export interface CutoverView {
  opId: string;
  run: CutoverRunView | null;
  summary: { total: number; planned: number; certReady: number; ready: number; switched: number; verified: number; blocked: number; conflict: number; failed: number; excluded: number };
  servers: CutoverServerView[];
  entries: CutoverEntryView[];
  certs: { staged: number; applied: number };
}

export interface CutoverFlipPlanRecord {
  type: string;
  name: string;
  action: "create" | "update" | "delete" | "noop";
  old: { content: string; ttl: number; proxied: boolean } | null;
  new: { content: string; ttl: number; proxied: boolean } | null;
}
export interface CutoverFlipPlan {
  opId: string;
  planHash: string;
  entries: Array<{ hostname: string; appName: string; challenge: string; records: CutoverFlipPlanRecord[]; warnings: string[] }>;
  rate: { batchSize: number; intervalSec: number; estimatedSeconds: number };
  blocked: Array<{ hostname: string; reason: string }>;
  copyPaste: Array<{ hostname: string; type: string; name: string; content: string; ttl: number; lowerTtlBefore: string | null }>;
  sourceStop: Array<{ appName: string; sourceName: string | null; hostnames: string[] }>;
}
export interface CutoverTtlGuidance { hostname: string; oldTtl: number; lowerBefore: string | null }
export interface CutoverFlipInput {
  confirmToken: string;
  hostnames?: string[];
  batchSize?: number;
  intervalSec?: number;
  targetTtl?: number;
  stopOnFail?: boolean;
  autoRevert?: boolean;
  keepProxied?: boolean;
  acceptDataRisk?: boolean;
  acceptHttp01Gap?: boolean;
  skipTtlWait?: boolean;
}
export interface CutoverFlipPlanQuery { hostnames?: string[]; targetTtl?: number; keepProxied?: boolean }

const cutoverBase = (opId: string) => `/import/operations/${encodeURIComponent(opId)}/cutover`;
const cutoverPost = <T>(opId: string, sub: string, body?: unknown) =>
  apiFetch<T>(`${cutoverBase(opId)}${sub}`, { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

export const api = {
  async register(email: string, password: string, name?: string, setupCode?: string) {
    // The hub sets the httpOnly session cookies on the response; we only need the user back.
    const out = await apiFetch<{ user: PublicUser; tokens: TokenPair }>(
      "/auth/register",
      { method: "POST", body: JSON.stringify({ email, password, name, setupCode }) },
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
    return apiFetch<InstanceStatus>("/instance/status", {}, false).then((st) => {
      rememberHubUrl(st?.hubPublicUrl);
      return st;
    });
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
  // Owner-only backup of the hub's OWN control-plane Postgres (session-auth).
  getHubBackup() {
    return apiFetch<HubBackupView>("/instance/backup");
  },
  setHubBackup(body: { enabled: boolean; intervalHours: number; cron?: string | null; retention: number; retentionDays?: number | null; maxSizeGb?: number | null; destinationId: string | null }) {
    return apiFetch<HubBackupView>("/instance/backup", { method: "PUT", body: JSON.stringify(body) });
  },
  runHubBackup() {
    return apiFetch<HubBackupItem>("/instance/backup/run", { method: "POST" });
  },
  testHubBackup() {
    return apiFetch<{ ok: boolean; output: string }>("/instance/backup/test", { method: "POST" });
  },
  deleteHubBackupItem(id: string) {
    return apiFetch<{ ok: true }>(`/instance/backup/items/${id}`, { method: "DELETE" });
  },
  // Owner-only: every encrypted destination's data key, sealed (openssl enc) under a passphrase the owner picks.
  exportDestinationKeys(passphrase: string) {
    return apiFetch<SealedKeyExport>("/instance/backup/destination-keys/export", { method: "POST", body: JSON.stringify({ passphrase }) });
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
  // Owner-only outbound mail (SMTP / Resend) settings. password / resendKey are write-only (blank = keep).
  getMailSettings() {
    return apiFetch<MailSettings>("/instance/mail");
  },
  updateMailSettings(patch: {
    provider?: MailProvider;
    host?: string | null;
    port?: number | null;
    secure?: boolean;
    user?: string | null;
    from?: string | null;
    password?: string;
    resendKey?: string;
  }) {
    return apiFetch<MailSettings>("/instance/mail", { method: "PATCH", body: JSON.stringify(patch) });
  },
  testMailSettings(to: string) {
    return apiFetch<{ ok: boolean; reason?: string }>("/instance/mail/test", { method: "POST", body: JSON.stringify({ to }) });
  },
  // Running version + "newer release published" for any signed-in member (session-guarded on the hub).
  getInstanceVersion() {
    return apiFetch<InstanceVersionSummary>("/instance/version");
  },
  // Owner-only self-update status + preferences (session-guarded on the hub).
  getInstanceUpdate() {
    return apiFetch<InstanceUpdateStatus>("/instance/update");
  },
  updateInstanceUpdate(patch: { autoUpdate?: boolean; updateChannel?: "stable" | "beta" | null }) {
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
  // Public white-label branding (themes the login page pre-auth). No refresh-retry (unauthenticated).
  getBranding() {
    return apiFetch<Branding>("/instance/branding", {}, false);
  },
  // Owner-only white-label update (Pro; the hub 403s below Pro). "" clears a field back to the Tugra default.
  updateBranding(patch: { name?: string | null; logoUrl?: string | null; faviconUrl?: string | null; accentColor?: string | null; hidePoweredBy?: boolean }) {
    return apiFetch<Branding>("/instance/branding", { method: "PATCH", body: JSON.stringify(patch) });
  },
  // Owner-only control-panel HTTPS (DİLİM 1): status + idempotent re-apply. Session-only (not a PAT).
  getPanelTls() {
    return apiFetch<PanelTlsStatus>("/instance/panel-tls");
  },
  applyPanelTls() {
    return apiFetch<PanelTlsStatus>("/instance/panel-tls/apply", { method: "POST" });
  },
  // Owner-only panel domain: set / change / remove it from Settings (the change runs in the background; poll the status).
  getPanelDomain() {
    return apiFetch<PanelDomainStatus>("/instance/panel-domain");
  },
  setPanelDomain(body: { domain: string; acmeEmail?: string }) {
    return apiFetch<PanelDomainStatus>("/instance/panel-domain", { method: "POST", body: JSON.stringify(body) });
  },
  removePanelDomain(body: { publicIp?: string } = {}) {
    return apiFetch<PanelDomainStatus>("/instance/panel-domain/remove", { method: "POST", body: JSON.stringify(body) });
  },
  // Stop waiting for the agents that have not moved to the new address: the old address stops being routed for them now.
  releasePanelDomainAgents() {
    return apiFetch<PanelDomainStatus>("/instance/panel-domain/agents/release", { method: "POST" });
  },
  // Owner-only anonymous usage stats (on by default, opt-out). Status includes a live payload preview.
  getTelemetry() {
    return apiFetch<TelemetryStatus>("/instance/telemetry");
  },
  updateTelemetry(enabled: boolean) {
    return apiFetch<TelemetryStatus>("/instance/telemetry", { method: "PATCH", body: JSON.stringify({ enabled }) });
  },
  sendTelemetryNow() {
    return apiFetch<{ status: "sent" | "disabled" | "error" }>("/instance/telemetry/send", { method: "POST" });
  },
  resetTelemetryId() {
    return apiFetch<TelemetryStatus>("/instance/telemetry/reset", { method: "POST" });
  },
  // Master-key rotation (owner, session-only): status of stored secrets vs the current key + re-encrypt trigger.
  getSecretsKeyStatus() {
    return apiFetch<SecretsKeyStatus>("/instance/secrets-key");
  },
  reencryptSecrets() {
    return apiFetch<{ startedAt: string }>("/instance/secrets-key/reencrypt", { method: "POST" });
  },
  // Rotate with no restart: a new random data key becomes active (target "new-key"), or "env-root" goes back to the
  // .env key. `expectedCurrentKeyId` is a compare-and-set against the key the page saw (409 stale_current).
  rotateSecretsKey(body: { expectedCurrentKeyId: string; target?: "new-key" | "env-root"; reencrypt?: boolean }) {
    return apiFetch<{ keyId: string; epoch: number; reencryptStarted: boolean }>("/instance/secrets-key/rotate", { method: "POST", body: JSON.stringify(body) });
  },
  retireSecretsKey(keyId: string) {
    return apiFetch<{ keyId: string; state: "RETIRED" }>(`/instance/secrets-key/keys/${encodeURIComponent(keyId)}/retire`, { method: "POST" });
  },
  restoreSecretsKey(keyId: string) {
    return apiFetch<{ keyId: string; state: "DECRYPT_ONLY" }>(`/instance/secrets-key/keys/${encodeURIComponent(keyId)}/restore`, { method: "POST" });
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
  // Docker Swarm formation: form the swarm, read live status, dissolve it.
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
  getIngress(id: string) {
    return apiFetch<IngressView>(`/clusters/${id}/ingress`);
  },
  setIngressReplicas(id: string, replicas: number) {
    return apiFetch<IngressView>(`/clusters/${id}/ingress`, { method: "PATCH", body: JSON.stringify({ replicas }) });
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
  getDatabaseContainerMetrics(id: string, range: MetricsRange) {
    return apiFetch<AppContainerMetrics>(`/databases/${id}/metrics/containers?range=${range}`);
  },
  // Traffic Analytics (read-level): team-scoped aggregates of the proxy access log.
  getTrafficSummary(p: { range?: MetricsRange; teamId?: string | null; domain?: string | null; appId?: string | null } = {}) {
    return apiFetch<TrafficSummary>(`/traffic/summary${trafficQuery(p)}`);
  },
  getTrafficPaths(p: { range?: MetricsRange; teamId?: string | null; domain?: string | null; appId?: string | null; limit?: number } = {}) {
    return apiFetch<TrafficPaths>(`/traffic/paths${trafficQuery(p)}`);
  },
  getTrafficCountries(p: { range?: MetricsRange; teamId?: string | null; domain?: string | null; appId?: string | null; limit?: number } = {}) {
    return apiFetch<TrafficCountries>(`/traffic/countries${trafficQuery(p)}`);
  },
  getTrafficBreakdown(dim: TrafficBreakdownDim, p: { range?: MetricsRange; teamId?: string | null; domain?: string | null; appId?: string | null; limit?: number } = {}) {
    const q = trafficQuery(p);
    return apiFetch<TrafficBreakdown>(`/traffic/breakdown${q ? `${q}&` : "?"}dim=${encodeURIComponent(dim)}`);
  },
  getTrafficDomains(p: { range?: MetricsRange; teamId?: string | null } = {}) {
    return apiFetch<TrafficDomainRow[]>(`/traffic/domains${trafficQuery(p)}`);
  },
  setServerTrafficAnalytics(id: string, enabled: boolean) {
    return apiFetch<TrafficAnalyticsState>(`/servers/${id}/traffic-analytics`, { method: "PUT", body: JSON.stringify({ enabled }) });
  },
  getServerContainers(id: string) {
    return apiFetch<ServerContainers>(`/servers/${id}/metrics/containers`);
  },
  // Live host-wide list incl. stopped containers (for the Start action on a stopped container).
  getServerContainersAll(id: string) {
    return apiFetch<HostContainers>(`/servers/${id}/containers/all`);
  },
  // Read-level, DB-only: last-known container state + recent crash/OOM episodes for an app (agent need
  // not be online). logTail is redacted server-side unless the caller may read secrets.
  getAppRuntimeState(id: string) {
    return apiFetch<AppRuntimeState>(`/apps/${id}/runtime-state`);
  },
  // Fleet overview: newest metrics sample for every server the caller can see, in one call.
  getFleetMetrics() {
    return apiFetch<FleetLatestRow[]>("/fleet/metrics/latest");
  },
  // Sparkline source: each visible server's last `minutes` of per-minute CPU/mem %, in one batch call.
  getFleetTrend(minutes = 30) {
    return apiFetch<FleetTrendRow[]>(`/fleet/metrics/trend?minutes=${minutes}`);
  },
  // Hottest containers across every server the caller can see (top `limit` by CPU, live only).
  getFleetHottestContainers(limit = 10, teamId?: string) {
    const qs = new URLSearchParams({ limit: String(limit) });
    if (teamId) qs.set("teamId", teamId);
    return apiFetch<HottestContainerRow[]>(`/fleet/containers/hottest?${qs}`);
  },
  containerAction(id: string, container: string, action: "start" | "restart" | "stop" | "remove", confirmName?: string) {
    return apiFetch<{ ok: true }>(`/servers/${id}/containers/action`, {
      method: "POST",
      body: JSON.stringify({ container, action, confirmName }),
    });
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
    return apiFetch<{ ok: boolean; reclaimed: string; output: string }>(`/servers/${id}/cleanup`, { method: "POST" });
  },
  diskUsage(id: string) {
    return apiFetch<DiskUsage>(`/servers/${id}/disk-usage`);
  },
  getServerGpus(id: string) {
    return apiFetch<GpuReport>(`/servers/${id}/gpus`);
  },
  refreshServerGpus(id: string) {
    return apiFetch<GpuReport>(`/servers/${id}/gpus/refresh`, { method: "POST" });
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
  listProxyDynamicConfigs(id: string) {
    return apiFetch<{ configs: { name: string; content: string; updatedAt: string }[] }>(`/servers/${id}/proxy/dynamic`);
  },
  putProxyDynamicConfig(id: string, name: string, content: string) {
    return apiFetch<{ ok: true }>(`/servers/${id}/proxy/dynamic/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify({ content }) });
  },
  deleteProxyDynamicConfig(id: string, name: string) {
    return apiFetch<{ ok: true }>(`/servers/${id}/proxy/dynamic/${encodeURIComponent(name)}`, { method: "DELETE" });
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
  createLogDrain(serverId: string, input: LogDrainInput & { name: string; endpoint: string }) {
    return apiFetch<LogDrain>(`/servers/${serverId}/log-drains`, { method: "POST", body: JSON.stringify(input) });
  },
  updateLogDrain(serverId: string, drainId: string, input: LogDrainInput) {
    return apiFetch<LogDrain>(`/servers/${serverId}/log-drains/${drainId}`, { method: "PUT", body: JSON.stringify(input) });
  },
  deleteLogDrain(serverId: string, drainId: string) {
    return apiFetch<{ ok: true }>(`/servers/${serverId}/log-drains/${drainId}`, { method: "DELETE" });
  },
  // App drains shipping logs off this server: name/type/app/delivery only (the operator never sees an app
  // writer's endpoint or credentials).
  listServerAppDrains(serverId: string) {
    return apiFetch<AppDrainSummary[]>(`/servers/${serverId}/log-drains/apps`);
  },
  // Per-app log drains (D7): same shape as the server routes, scoped to one app's containers.
  listAppLogDrains(appId: string) {
    return apiFetch<LogDrain[]>(`/apps/${appId}/log-drains`);
  },
  createAppLogDrain(appId: string, input: LogDrainInput & { name: string; endpoint: string }) {
    return apiFetch<LogDrain>(`/apps/${appId}/log-drains`, { method: "POST", body: JSON.stringify(input) });
  },
  updateAppLogDrain(appId: string, drainId: string, input: LogDrainInput) {
    return apiFetch<LogDrain>(`/apps/${appId}/log-drains/${drainId}`, { method: "PUT", body: JSON.stringify(input) });
  },
  deleteAppLogDrain(appId: string, drainId: string) {
    return apiFetch<{ ok: true }>(`/apps/${appId}/log-drains/${drainId}`, { method: "DELETE" });
  },
  /** Reboot server: the live reboot (if any) and the last finished one with its verification report. */
  getServerReboot(id: string) {
    return apiFetch<RebootStatus>(`/servers/${id}/reboot`);
  },
  /** What a reboot would take down (counts) — for the confirmation dialog. */
  getServerRebootPreview(id: string) {
    return apiFetch<RebootPreview>(`/servers/${id}/reboot/preview`);
  },
  requestServerReboot(id: string, body: RebootRequest) {
    return apiFetch<RebootView>(`/servers/${id}/reboot`, { method: "POST", body: JSON.stringify(body) });
  },
  /** Cancel a SCHEDULED reboot (one that already started cannot be cancelled). */
  cancelServerReboot(id: string) {
    return apiFetch<RebootView>(`/servers/${id}/reboot`, { method: "DELETE" });
  },
  upgradeAll(id: string) {
    return apiFetch<{ output: string; exitCode: number }>(`/servers/${id}/updates/apply`, { method: "POST" });
  },
  upgradeOne(id: string, pkg: string) {
    return apiFetch<{ output: string; exitCode: number }>(`/servers/${id}/updates/apply/${pkg}`, { method: "POST" });
  },
  /** Install one phased (gradually rolled out) apt package now, ahead of Ubuntu's rollout reaching this server. */
  upgradePhased(id: string, pkg: string) {
    return apiFetch<{ output: string; exitCode: number }>(`/servers/${id}/updates/apply/${pkg}/phased`, { method: "POST" });
  },
  setCleanupConfig(id: string, cfg: { enabled: boolean; intervalHours?: number; cron?: string | null; thresholdPct?: number | null; volumes?: boolean }) {
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
      /** Copy a team DNS credential's token onto the server (a later rotation does NOT propagate until re-applied). null clears the link. */
      dnsFromCredentialId?: string | null;
    },
  ) {
    return apiFetch<{ ok: true }>(`/servers/${id}/network`, {
      method: "PUT",
      body: JSON.stringify(cfg),
    });
  },
  bulkSetCleanupConfig(serverIds: string[], cfg: { enabled: boolean; intervalHours?: number; cron?: string | null; thresholdPct?: number | null; volumes?: boolean }) {
    return apiFetch<{ applied: string[]; skipped: string[] }>(`/fleet/cleanup-config`, {
      method: "POST",
      body: JSON.stringify({ serverIds, ...cfg }),
    });
  },
  bulkCheckUpdates(serverIds: string[]) {
    return apiFetch<FleetPatchCheckResult>(`/fleet/updates/check`, {
      method: "POST",
      body: JSON.stringify({ serverIds }),
    });
  },
  bulkUpgradeAll(serverIds: string[]) {
    return apiFetch<FleetPatchApplyResult>(`/fleet/updates/apply`, {
      method: "POST",
      body: JSON.stringify({ serverIds }),
    });
  },
  updateAgent(id: string) {
    return apiFetch<AgentUpdateResponse>(`/servers/${id}/agent-update`, { method: "POST" });
  },
  listServerAudit(id: string, cursor?: string) {
    const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    return apiFetch<AuditPage>(`/servers/${id}/audit${qs}`);
  },
  bulkUpdateAgent(serverIds: string[]) {
    return apiFetch<AgentUpdateResponse>(`/fleet/agent-update`, {
      method: "POST",
      body: JSON.stringify({ serverIds }),
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
  // Fleet fan-out: add many servers to one team at once, each with its own enroll token + install command.
  createServersBulk(names: string[], teamId: string) {
    return apiFetch<{ servers: { server: ServerView; enrollToken: string; installCommand: string }[] }>("/servers/bulk", {
      method: "POST",
      body: JSON.stringify({ names, teamId }),
    });
  },
  deleteServer(id: string, opts?: { destroyVm?: boolean }) {
    return apiFetch<{ ok: true }>(`/servers/${id}${opts?.destroyVm ? "?destroyVm=true" : ""}`, { method: "DELETE" });
  },
  // Out-of-band (cloud provider) power, rescue and console — work while the server's agent is offline.
  getServerOob(id: string) {
    return apiFetch<OobStatus>(`/servers/${id}/oob`);
  },
  oobPower(id: string, body: { action: OobPowerAction; confirmName?: string }) {
    return apiFetch<OobActionResult>(`/servers/${id}/oob/power`, { method: "POST", body: JSON.stringify(body) });
  },
  /** The response carries the one-time rescue root password: never cache it. */
  oobEnableRescue(id: string) {
    return apiFetch<OobRescueResult>(`/servers/${id}/oob/rescue`, { method: "POST" });
  },
  oobDisableRescue(id: string) {
    return apiFetch<OobActionResult>(`/servers/${id}/oob/rescue`, { method: "DELETE" });
  },
  /** The response carries the console websocket URL + VNC password (one minute): never cache it. */
  oobConsole(id: string) {
    return apiFetch<OobConsoleResult>(`/servers/${id}/oob/console`, { method: "POST" });
  },
  oobCandidates(id: string, cloudCredentialId: string) {
    return apiFetch<OobCandidate[]>(`/servers/${id}/oob/candidates?cloudCredentialId=${encodeURIComponent(cloudCredentialId)}`);
  },
  oobLink(id: string, body: { cloudCredentialId: string; providerServerId: string; confirmProviderName?: string }) {
    return apiFetch<OobStatus>(`/servers/${id}/oob/link`, { method: "PUT", body: JSON.stringify(body) });
  },
  oobUnlink(id: string) {
    return apiFetch<OobStatus>(`/servers/${id}/oob/link`, { method: "DELETE" });
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
  // DNS-provider credentials (Cloudflare) for one-click custom-domain setup.
  listDnsCredentials() {
    return apiFetch<DnsCredential[]>("/dns-credentials");
  },
  createDnsCredential(input: { teamId: string; name: string; provider: string; apiToken: string; cfAccountId?: string }) {
    return apiFetch<DnsCredential>("/dns-credentials", { method: "POST", body: JSON.stringify(input) });
  },
  testDnsCredential(id: string) {
    return apiFetch<{ ok: true }>(`/dns-credentials/${id}/test`, { method: "POST" });
  },
  deleteDnsCredential(id: string) {
    return apiFetch<{ ok: true }>(`/dns-credentials/${id}`, { method: "DELETE" });
  },
  // External secret stores (HashiCorp Vault). The access token is write-only — sent on create/update, never read back.
  listSecretProviders() {
    return apiFetch<SecretProvider[]>("/secret-providers");
  },
  createSecretProvider(input: { teamId: string; name: string; kind: "vault"; address: string; token: string }) {
    return apiFetch<SecretProvider>("/secret-providers", { method: "POST", body: JSON.stringify(input) });
  },
  updateSecretProvider(id: string, input: { name?: string; address?: string; token?: string }) {
    return apiFetch<SecretProvider>(`/secret-providers/${id}`, { method: "PUT", body: JSON.stringify(input) });
  },
  testSecretProvider(id: string) {
    return apiFetch<{ ok: true }>(`/secret-providers/${id}/test`, { method: "POST" });
  },
  deleteSecretProvider(id: string) {
    return apiFetch<{ ok: true }>(`/secret-providers/${id}`, { method: "DELETE" });
  },
  // One-click custom-domain DNS auto-setup. dryRun=true returns the plan without writing.
  autoSetupDomain(
    id: string,
    input: { domain: string; credentialId?: string; includeWww?: boolean; overwrite?: boolean; dryRun?: boolean },
  ) {
    return apiFetch<DnsAutoSetupResult>(`/apps/${id}/domain/auto-setup`, { method: "POST", body: JSON.stringify(input) });
  },
  // The copy-paste records to create by hand at any DNS provider (manual fallback).
  getManualDnsRecords(id: string, domain: string, includeWww = true) {
    const q = new URLSearchParams({ domain, includeWww: String(includeWww) });
    return apiFetch<DnsManualRecords>(`/apps/${id}/domain/manual-records?${q.toString()}`);
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
  // Pro-only full-trail export (server-side, all rows, CSV or JSON). Same cookie auth as apiFetch with one
  // refresh retry; throws ApiError(403) on Community. Returns the Blob + whether the result was capped
  // (X-Tugra-Audit-Truncated) so the caller can warn the user to narrow the date range.
  async exportAudit(teamId: string | undefined, format: "csv" | "json"): Promise<{ blob: Blob; truncated: boolean }> {
    const params = new URLSearchParams({ format });
    if (teamId) params.set("teamId", teamId);
    const url = `${API_BASE}/audit/export?${params.toString()}`;
    let res = await fetch(url, { credentials: "include" });
    if (res.status === 401 && (await tryRefresh())) res = await fetch(url, { credentials: "include" });
    if (!res.ok) throw new ApiError(res.status, res.status === 403 ? "pro-only" : `export failed (${res.status})`);
    return { blob: await res.blob(), truncated: res.headers.get("X-Tugra-Audit-Truncated") === "1" };
  },
  listGitSources() {
    return apiFetch<GitSource[]>("/git-sources");
  },
  createGitSource(
    input:
      | { name: string; teamId: string; appId: string; privateKey: string; installationId?: string; webhookSecret?: string }
      | { kind: "gitea" | "forgejo" | "codeberg"; name: string; teamId: string; apiUrl?: string; token: string },
  ) {
    return apiFetch<GitSource>("/git-sources", { method: "POST", body: JSON.stringify(input) });
  },
  listSourceRepos(id: string) {
    return apiFetch<SourceRepo[]>(`/git-sources/${id}/repos`);
  },
  listSourceBranches(id: string, repo: string) {
    return apiFetch<SourceBranch[]>(`/git-sources/${id}/branches?repo=${encodeURIComponent(repo)}`);
  },
  setGitSourceSharing(id: string, sharedAllTeams: boolean) {
    return apiFetch<GitSource>(`/git-sources/${id}/sharing`, { method: "PATCH", body: JSON.stringify({ sharedAllTeams }) });
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
  setAppBuildConfig(id: string, cfg: { registryId?: string | null; pushToRegistry?: boolean; buildServerId?: string | null; pushImageName?: string | null; pushImageTag?: string | null }) {
    return apiFetch<{ ok: true }>(`/apps/${id}/build-config`, { method: "PUT", body: JSON.stringify(cfg) });
  },
  setAppDeploySettings(id: string, cfg: { deployStrategy?: "ROLLING" | "RECREATE"; rollbackOnFailure?: boolean; imagesToKeep?: number | null; postCutoverSoakSec?: number; stopGracePeriodSec?: number | null; drainSec?: number | null }) {
    return apiFetch<{ ok: true }>(`/apps/${id}/deploy-settings`, { method: "PUT", body: JSON.stringify(cfg) });
  },
  setAppClusterConfig(id: string, cfg: { clusterId?: string | null; replicas?: number | null }) {
    return apiFetch<{ ok: true }>(`/apps/${id}/cluster-config`, { method: "PUT", body: JSON.stringify(cfg) });
  },
  setAppCert(id: string, cert: string, key: string) {
    return apiFetch<{ domains: string[]; notAfter: string }>(`/apps/${id}/cert`, { method: "PUT", body: JSON.stringify({ cert, key }) });
  },
  clearAppCert(id: string) {
    return apiFetch<{ ok: true }>(`/apps/${id}/cert`, { method: "DELETE" });
  },
  cloneApp(id: string, body: { name?: string; serverId?: string; environmentId?: string }) {
    return apiFetch<{ app: Application; warnings: string[] }>(`/apps/${id}/clone`, { method: "POST", body: JSON.stringify(body) });
  },
  previewAppMove(id: string, body: { targetServerId: string; acknowledge?: MoveAcks; probeLink?: boolean }) {
    return apiFetch<MovePreflightResult>(`/apps/${id}/move/preflight`, { method: "POST", body: JSON.stringify(body) });
  },
  startAppMove(id: string, body: { targetServerId: string; acknowledge: MoveAcks; repointDns: boolean; archiveRetainDays: number; confirmName: string }) {
    return apiFetch<{ moveId: string; phase: AppMovePhase }>(`/apps/${id}/move`, { method: "POST", body: JSON.stringify(body) });
  },
  getAppMoves(id: string, opts?: { active?: boolean; limit?: number }) {
    const q = new URLSearchParams();
    if (opts?.active) q.set("active", "true");
    if (opts?.limit) q.set("limit", String(opts.limit));
    const qs = q.toString();
    return apiFetch<AppMove[]>(`/apps/${id}/moves${qs ? `?${qs}` : ""}`);
  },
  getAppMove(id: string, moveId: string) {
    return apiFetch<AppMove>(`/apps/${id}/moves/${moveId}`);
  },
  cancelAppMove(id: string, moveId: string) {
    return apiFetch<{ ok: true }>(`/apps/${id}/moves/${moveId}/cancel`, { method: "POST" });
  },
  purgeMoveSource(id: string, moveId: string) {
    return apiFetch<{ ok: true }>(`/apps/${id}/moves/${moveId}/purge-source`, { method: "POST" });
  },
  cancelDeployment(id: string, deploymentId: string) {
    return apiFetch<Deployment>(`/apps/${id}/deployments/${deploymentId}/cancel`, { method: "POST" });
  },
  setAppExtraDomains(id: string, domains: string[]) {
    return apiFetch<{ ok: true }>(`/apps/${id}/extra-domains`, { method: "PUT", body: JSON.stringify({ domains }) });
  },
  getServiceDomains(id: string) {
    return apiFetch<{ service: string; hostname: string; port: number }[]>(`/apps/${id}/service-domains`);
  },
  setServiceDomains(id: string, domains: { service: string; hostname: string; port: number }[]) {
    return apiFetch<{ ok: true }>(`/apps/${id}/service-domains`, { method: "PUT", body: JSON.stringify({ domains }) });
  },
  generateGitSshKey(id: string) {
    return apiFetch<{ publicKey: string; fingerprint: string }>(`/apps/${id}/git-ssh-key`, { method: "POST" });
  },
  removeGitSshKey(id: string) {
    return apiFetch<{ ok: true }>(`/apps/${id}/git-ssh-key`, { method: "DELETE" });
  },
  // Edit the source after create. `warnings` reports credential resets (host change cleared a token, etc.).
  setAppSource(id: string, body: { gitUrl?: string; gitBranch?: string; gitCommit?: string | null; gitSourceId?: string | null; image?: string; composePath?: string }) {
    return apiFetch<{ warnings: string[] }>(`/apps/${id}/source`, { method: "PUT", body: JSON.stringify(body) });
  },
  setAppBuild(id: string, body: { buildType: BuildType; dockerfilePath?: string | null; dockerBuildTarget?: string | null; inlineDockerfile?: string | null; buildCommand?: string | null; outputDir?: string | null; baseDirectory?: string | null; nixpacksInstallCmd?: string | null; nixpacksBuildCmd?: string | null; nixpacksStartCmd?: string | null; gitSubmodules?: boolean; gitLfs?: boolean; gitShallowClone?: boolean; disableBuildCache?: boolean; injectEnvAsBuildArgs?: boolean; sourceCommitMode?: SourceCommitMode }) {
    return apiFetch<{ ok: true }>(`/apps/${id}/build`, { method: "PUT", body: JSON.stringify(body) });
  },
  setAppWatchPaths(id: string, watchPaths: string[]) {
    return apiFetch<{ ok: true }>(`/apps/${id}/watch-paths`, { method: "PUT", body: JSON.stringify({ watchPaths }) });
  },
  setImageUpdateCheck(id: string, enabled: boolean) {
    return apiFetch<{ ok: true }>(`/apps/${id}/image-update-check`, { method: "PUT", body: JSON.stringify({ enabled }) });
  },
  /** "Check now": probe the upstream registry from the app's own server (apps:deploy, throttled by the hub). */
  checkImageUpdate(id: string) {
    return apiFetch<{ imageUpdate: ImageUpdate }>(`/apps/${id}/image-update-check`, { method: "POST" });
  },
  setAppAutoDeploy(id: string, enabled: boolean) {
    return apiFetch<{ ok: true }>(`/apps/${id}/auto-deploy`, { method: "PUT", body: JSON.stringify({ enabled }) });
  },
  setAppExtraPorts(id: string, ports: { hostPort: number; containerPort: number; protocol: "tcp" | "udp" }[]) {
    return apiFetch<{ ok: true }>(`/apps/${id}/extra-ports`, { method: "PUT", body: JSON.stringify({ ports }) });
  },
  setAppNetworkAliases(id: string, aliases: string[]) {
    return apiFetch<{ ok: true }>(`/apps/${id}/network-aliases`, { method: "PUT", body: JSON.stringify({ aliases }) });
  },
  setAppNetworks(id: string, cfg: { networks?: string[]; containerAlias?: string | null }) {
    return apiFetch<{ ok: true }>(`/apps/${id}/networks`, { method: "PUT", body: JSON.stringify(cfg) });
  },
  setAppContainerPort(id: string, containerPort: number) {
    return apiFetch<{ ok: true }>(`/apps/${id}/container-port`, { method: "PUT", body: JSON.stringify({ containerPort }) });
  },
  setAppBasicAuth(id: string, users: { user: string; password: string }[]) {
    return apiFetch<{ ok: true }>(`/apps/${id}/basic-auth`, { method: "PUT", body: JSON.stringify({ users }) });
  },
  setAppRedirects(id: string, redirects: { regex: string; replacement: string; permanent: boolean }[]) {
    return apiFetch<{ ok: true }>(`/apps/${id}/redirects`, { method: "PUT", body: JSON.stringify({ redirects }) });
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
    composePath?: string;
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
  getVolumeBackupConfig(appId: string) {
    return apiFetch<VolumeBackupConfig>(`/apps/${appId}/volume-backups/config`);
  },
  // cron / retentionDays / maxSizeGb: omitted leaves the stored value, null clears it.
  setVolumeBackupConfig(
    appId: string,
    cfg: { enabled: boolean; intervalHours?: number | null; cron?: string | null; retention?: number; retentionDays?: number | null; maxSizeGb?: number | null; destinationId?: string | null },
  ) {
    return apiFetch<Application>(`/apps/${appId}/volume-backups/config`, { method: "PUT", body: JSON.stringify(cfg) });
  },
  // Per-volume policy (absent/null fields inherit the app's). DELETE reverts the volume to inherit.
  putVolumePolicy(
    appId: string,
    volumeName: string,
    p: { enabled: boolean; intervalHours?: number | null; cron?: string | null; retention?: number | null; retentionDays?: number | null; maxSizeGb?: number | null },
  ) {
    return apiFetch<VolumeBackupPolicy>(`/apps/${appId}/volume-backups/policies/${encodeURIComponent(volumeName)}`, { method: "PUT", body: JSON.stringify(p) });
  },
  deleteVolumePolicy(appId: string, volumeName: string) {
    return apiFetch<{ ok: true }>(`/apps/${appId}/volume-backups/policies/${encodeURIComponent(volumeName)}`, { method: "DELETE" });
  },
  // When a cron will really fire (hub timezone) + its tightest gap; an invalid cron is valid:false, never an error.
  previewSchedule(cron: string, count = 3) {
    return apiFetch<SchedulePreview>(`/backup-schedules/preview?cron=${encodeURIComponent(cron)}&count=${count}`);
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
  deleteApp(id: string, opts: { keepVolumes?: boolean; removeImages?: boolean; pruneNetworks?: boolean; pruneBuildCache?: boolean } = {}) {
    const q = [opts.keepVolumes ? "keepVolumes=1" : "", opts.removeImages ? "removeImages=1" : "", opts.pruneNetworks ? "pruneNetworks=1" : "", opts.pruneBuildCache ? "pruneBuildCache=1" : ""].filter(Boolean).join("&");
    return apiFetch<{ ok: true }>(`/apps/${id}${q ? `?${q}` : ""}`, { method: "DELETE" });
  },
  getDeployments(id: string, opts?: { slim?: boolean }) {
    return apiFetch<Deployment[]>(`/apps/${id}/deployments${opts?.slim ? "?slim=1" : ""}`);
  },
  /** One deployment with its full log + derived facts (detail page). */
  getDeployment(id: string, deploymentId: string) {
    return apiFetch<DeploymentDetail>(`/apps/${id}/deployments/${deploymentId}`);
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
  listAppFiles(id: string, volume: string, path = "") {
    const qs = new URLSearchParams({ volume, ...(path ? { path } : {}) });
    return apiFetch<FileListing>(`/apps/${id}/files?${qs}`);
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
  setAppDescription(id: string, description: string | null) {
    return apiFetch<{ ok: true }>(`/apps/${id}/description`, { method: "PUT", body: JSON.stringify({ description }) });
  },
  // Custom app icon: `data` is a base64 PNG (no data: prefix). The server validates it is a real square
  // 32-512px PNG under 64KB. deleteAppIcon clears it (falls back to the template/source logo).
  setAppIcon(id: string, data: string) {
    return apiFetch<{ ok: true }>(`/apps/${id}/icon`, { method: "PUT", body: JSON.stringify({ data }) });
  },
  deleteAppIcon(id: string) {
    return apiFetch<{ ok: true }>(`/apps/${id}/icon`, { method: "DELETE" });
  },
  setProjectIcon(id: string, data: string) {
    return apiFetch<{ ok: true }>(`/projects/${id}/icon`, { method: "PUT", body: JSON.stringify({ data }) });
  },
  deleteProjectIcon(id: string) {
    return apiFetch<{ ok: true }>(`/projects/${id}/icon`, { method: "DELETE" });
  },
  setTeamIcon(id: string, data: string) {
    return apiFetch<{ ok: true }>(`/teams/${id}/icon`, { method: "PUT", body: JSON.stringify({ data }) });
  },
  deleteTeamIcon(id: string) {
    return apiFetch<{ ok: true }>(`/teams/${id}/icon`, { method: "DELETE" });
  },
  setDatabaseIcon(id: string, data: string) {
    return apiFetch<{ ok: true }>(`/databases/${id}/icon`, { method: "PUT", body: JSON.stringify({ data }) });
  },
  deleteDatabaseIcon(id: string) {
    return apiFetch<{ ok: true }>(`/databases/${id}/icon`, { method: "DELETE" });
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
  setPreviewEnabled(id: string, enabled: boolean, excludeEnvKeys?: string[], limit?: number | null) {
    return apiFetch<{ ok: true }>(`/apps/${id}/preview-config`, {
      method: "PUT",
      body: JSON.stringify({ enabled, ...(excludeEnvKeys !== undefined ? { excludeEnvKeys } : {}), ...(limit !== undefined ? { limit } : {}) }),
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
  getAppEnvFlags(id: string) {
    return apiFetch<EnvFlagsResponse>(`/apps/${id}/env-flags`);
  },
  // `flags` is sent ONLY when provided: a present `flags` replaces every stored flag, an omitted one keeps them.
  setAppEnv(id: string, env: Record<string, string>, flags?: Record<string, Partial<EnvFlagView>>) {
    return apiFetch<{ ok: true }>(`/apps/${id}/env`, {
      method: "PUT",
      body: JSON.stringify(flags === undefined ? { env } : { env, flags }),
    });
  },
  getAppDatabaseLinks(id: string) {
    return apiFetch<DatabaseLinkView[]>(`/apps/${id}/database-links`);
  },
  linkAppDatabase(id: string, input: { databaseId: string; envVar?: string; adoptEnv?: boolean }) {
    return apiFetch<DatabaseLinkView>(`/apps/${id}/database-links`, { method: "POST", body: JSON.stringify(input) });
  },
  unlinkAppDatabase(id: string, linkId: string) {
    return apiFetch<{ ok: true }>(`/apps/${id}/database-links/${linkId}`, { method: "DELETE" });
  },
  getAppSecretRefs(id: string) {
    return apiFetch<SecretRefView[]>(`/apps/${id}/secret-refs`);
  },
  bindAppSecret(id: string, input: { providerId: string; envVar: string; remoteKey: string }) {
    return apiFetch<SecretRefView>(`/apps/${id}/secret-refs`, { method: "POST", body: JSON.stringify(input) });
  },
  unbindAppSecret(id: string, refId: string) {
    return apiFetch<{ ok: true }>(`/apps/${id}/secret-refs/${refId}`, { method: "DELETE" });
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
  // Build-time SECRETS (BuildKit --secret mounts, Dockerfile builds): never in image layers / history.
  getAppBuildSecrets(id: string) {
    return apiFetch<Record<string, string>>(`/apps/${id}/build-secrets`);
  },
  setAppBuildSecrets(id: string, buildSecrets: Record<string, string>) {
    return apiFetch<{ ok: true }>(`/apps/${id}/build-secrets`, {
      method: "PUT",
      body: JSON.stringify({ buildSecrets }),
    });
  },
  setAppDockerOptions(id: string, dockerOptions: string | null) {
    return apiFetch<{ ok: true }>(`/apps/${id}/docker-options`, {
      method: "PUT",
      body: JSON.stringify({ dockerOptions }),
    });
  },
  // Container labels: the read-only view of what Tugra applies + the custom ones (writer-only), and the editor's PUT
  // (replace semantics; {} = reset to defaults). The reserved prefixes/limits ride along in the GET.
  getAppLabels(id: string) {
    return apiFetch<AppLabelsView>(`/apps/${id}/labels`);
  },
  setAppCustomLabels(id: string, labels: Record<string, string>) {
    return apiFetch<{ ok: true }>(`/apps/${id}/custom-labels`, {
      method: "PUT",
      body: JSON.stringify({ labels }),
    });
  },
  // Instance-owner only (the hub enforces session + owner): lift the docker-options host-escape denylist.
  setAppAllowPrivilegedDockerOptions(id: string, allow: boolean) {
    return apiFetch<{ ok: true }>(`/apps/${id}/allow-privileged-docker-options`, {
      method: "PUT",
      body: JSON.stringify({ allow }),
    });
  },
  setAppDeployHooks(id: string, hooks: { preDeployCommand: string | null; postDeployCommand: string | null; composeHookService?: string | null }) {
    return apiFetch<{ ok: true }>(`/apps/${id}/deploy-hooks`, {
      method: "PUT",
      body: JSON.stringify(hooks),
    });
  },
  /** Resolved compose preview (redacted, never resolves ${VAR}). Runs on the app's agent: a click, never automatic. */
  previewAppCompose(id: string) {
    return apiFetch<ComposePreviewResult>(`/apps/${id}/compose-preview`, { method: "POST" });
  },
  setAppContainerCommand(id: string, body: { containerEntrypoint: string[] | null; containerCommand: string[] | null }) {
    return apiFetch<{ ok: true }>(`/apps/${id}/container-command`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  },
  setAppRestartPolicy(id: string, restartPolicy: string | null, maxRetries?: number | null) {
    return apiFetch<{ ok: true }>(`/apps/${id}/restart-policy`, { method: "PUT", body: JSON.stringify({ restartPolicy, ...(maxRetries !== undefined ? { maxRetries } : {}) }) });
  },
  setAppComposeFile(id: string, composeFile: string) {
    return apiFetch<{ ok: true }>(`/apps/${id}/compose-file`, {
      method: "PUT",
      body: JSON.stringify({ composeFile }),
    });
  },
  getAppConfigMounts(id: string) {
    return apiFetch<AppConfigMount[]>(`/apps/${id}/config-mounts`);
  },
  setAppConfigMount(id: string, body: { target: string; content: string }) {
    return apiFetch<{ ok: true }>(`/apps/${id}/config-mounts`, { method: "PUT", body: JSON.stringify(body) });
  },
  setAppPlacement(id: string, body: { constraints: PlacementConstraint[]; spreadLabelKey: string | null }) {
    return apiFetch<{ ok: boolean }>(`/apps/${id}/placement`, { method: "PUT", body: JSON.stringify(body) });
  },
  setAppLimits(id: string, limits: { memoryMb?: number | null; cpus?: number | null; reserveMemoryMb?: number | null; reserveCpus?: number | null; memorySwapMb?: number | null; pidsLimit?: number | null; shmSizeMb?: number | null; cpuShares?: number | null; cpusetCpus?: string | null; gpus?: string | null; deployTimeoutSec?: number | null }) {
    return apiFetch<{ ok: true }>(`/apps/${id}/limits`, {
      method: "PUT",
      body: JSON.stringify(limits),
    });
  },
  setAppHealthCheck(
    id: string,
    hc: {
      type?: string | null; path?: string | null; port?: number | null; command?: string | null;
      method?: string | null; scheme?: string | null; responseText?: string | null;
      interval?: number | null; timeout?: number | null; retries?: number | null; startPeriod?: number | null; expectedStatus?: number | null;
    },
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
  cloneDatabase(id: string, body: { name?: string; environmentId?: string }) {
    return apiFetch<{ id: string; warnings: string[] }>(`/databases/${id}/clone`, { method: "POST", body: JSON.stringify(body) });
  },
  getDatabaseEnv(id: string) {
    return apiFetch<Record<string, string>>(`/databases/${id}/env`);
  },
  setDatabaseEnv(id: string, env: Record<string, string>) {
    return apiFetch<{ ok: true }>(`/databases/${id}/env`, { method: "PUT", body: JSON.stringify({ env }) });
  },
  setDatabaseVolumes(id: string, volumes: { name: string; path: string }[]) {
    return apiFetch<{ ok: true }>(`/databases/${id}/volumes`, { method: "PUT", body: JSON.stringify({ volumes }) });
  },
  renameServer(id: string, name: string) {
    return apiFetch<{ ok: true }>(`/servers/${id}/name`, { method: "PUT", body: JSON.stringify({ name }) });
  },
  setServerDetails(id: string, body: { description?: string | null; timezone?: string | null }) {
    return apiFetch<{ ok: true }>(`/servers/${id}/details`, { method: "PUT", body: JSON.stringify(body) });
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
  setAppHostMounts(id: string, hostMounts: HostMount[]) {
    return apiFetch<{ ok: true }>(`/apps/${id}/host-mounts`, {
      method: "PUT",
      body: JSON.stringify({ hostMounts }),
    });
  },
  listAppTasks(id: string) {
    return apiFetch<ScheduledTask[]>(`/apps/${id}/tasks`);
  },
  createAppTask(id: string, task: { name: string; schedule: string; command: string; enabled?: boolean; timeoutSec?: number | null }) {
    return apiFetch<ScheduledTask>(`/apps/${id}/tasks`, { method: "POST", body: JSON.stringify(task) });
  },
  updateAppTask(id: string, taskId: string, patch: { name?: string; schedule?: string; command?: string; enabled?: boolean; timeoutSec?: number | null }) {
    return apiFetch<ScheduledTask>(`/apps/${id}/tasks/${taskId}`, { method: "PUT", body: JSON.stringify(patch) });
  },
  deleteAppTask(id: string, taskId: string) {
    return apiFetch<{ ok: true }>(`/apps/${id}/tasks/${taskId}`, { method: "DELETE" });
  },
  runAppTask(id: string, taskId: string) {
    return apiFetch<{ ok: true }>(`/apps/${id}/tasks/${taskId}/run`, { method: "POST" });
  },
  listAppTaskRuns(id: string, taskId: string) {
    return apiFetch<ScheduledTaskRun[]>(`/apps/${id}/tasks/${taskId}/runs`);
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
    opts: { domainRedirect?: "www" | "root" | null; securityHeaders?: boolean; gzip?: boolean; forwardAuth?: string | null; ipAllowlist?: string[]; pathPrefix?: string | null; stripPrefix?: boolean; dnsChallenge?: boolean; rateLimit?: { average: number; burst: number; period: "1s" | "1m" | "1h" } | null },
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
  moveDatabaseToServer(id: string, serverId: string) {
    return apiFetch<{ ok: true }>(`/databases/${id}/server`, {
      method: "PUT",
      body: JSON.stringify({ serverId }),
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
  renameEnvironment(envId: string, name: string) {
    return apiFetch<{ ok: true }>(`/projects/environments/${envId}`, { method: "PUT", body: JSON.stringify({ name }) });
  },
  cloneEnvironment(envId: string, body: { name?: string }) {
    return apiFetch<{ environmentId: string; projectId: string; apps: { cloned: number; failed: string[] }; databases: { cloned: number; failed: string[] }; relinked: number }>(
      `/projects/environments/${envId}/clone`,
      { method: "POST", body: JSON.stringify(body) },
    );
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
  deleteDatabase(id: string, keepVolume = false) {
    return apiFetch<{ ok: true }>(`/databases/${id}${keepVolume ? "?keepVolume=1" : ""}`, { method: "DELETE" });
  },

  // ── database backups ──
  listBackups(dbId: string) {
    return apiFetch<Backup[]>(`/databases/${dbId}/backups`);
  },
  getBackupUsage(dbId: string) {
    return apiFetch<BackupUsage>(`/databases/${dbId}/backup-usage`);
  },
  listRestores(dbId: string) {
    return apiFetch<Restore[]>(`/databases/${dbId}/restores`);
  },
  backupNow(dbId: string) {
    return apiFetch<Backup>(`/databases/${dbId}/backups`, { method: "POST" });
  },
  // Restore-verify drill: prove the latest successful backup actually restores (into a disposable throwaway).
  // Returns the VERIFY attestation; a FAILED status means the drill ran and the backup did not restore.
  verifyLatestBackup(dbId: string) {
    return apiFetch<Restore>(`/databases/${dbId}/backups/verify-latest`, { method: "POST" });
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
  setBackupConfig(dbId: string, cfg: { enabled: boolean; intervalHours?: number; cron?: string | null; retention?: number; retentionDays?: number | null; maxSizeGb?: number | null; destinationId?: string | null }) {
    return apiFetch<{ ok: true }>(`/databases/${dbId}/backup-config`, {
      method: "PUT",
      body: JSON.stringify(cfg),
    });
  },
  // Arm/disarm the scheduled restore-verify drill (prove the latest backup restores, on a cron/interval).
  setVerifyConfig(dbId: string, cfg: { enabled: boolean; intervalHours?: number; cron?: string | null }) {
    return apiFetch<{ ok: true }>(`/databases/${dbId}/verify-config`, {
      method: "PUT",
      body: JSON.stringify(cfg),
    });
  },
  // Scheduled physical base backups (the PITR anchors). Postgres-only; at most once every 6 hours.
  setBaseBackupConfig(dbId: string, cfg: { enabled: boolean; intervalHours?: number; cron?: string | null }) {
    return apiFetch<{ ok: true }>(`/databases/${dbId}/base-backup-config`, {
      method: "PUT",
      body: JSON.stringify(cfg),
    });
  },
  // PITR (Postgres): status + the enable/disable switch. Enable recreates the container with WAL archiving on
  // (a one-time restart) and verifies it end to end; disable drains the un-shipped WAL first. Both are
  // synchronous and can take a minute or more.
  getDatabasePitr(dbId: string) {
    return apiFetch<PitrStatus>(`/databases/${dbId}/pitr`);
  },
  setDatabasePitr(dbId: string, cfg: { enabled: boolean; purgeSpool?: boolean }) {
    return apiFetch<PitrStatus>(`/databases/${dbId}/pitr`, {
      method: "PUT",
      body: JSON.stringify(cfg),
    });
  },
  // Physical base backup (pg_basebackup) — the anchor a PITR recovery replays WAL onto. Long-running.
  baseBackupNow(dbId: string) {
    return apiFetch<{ id: string; status: string }>(`/databases/${dbId}/base-backups`, { method: "POST" });
  },
  // The recoverable window (approximate bounds) and the point-in-time restore itself: ASYNC — the hub answers
  // 202 with the new database + Restore ids and replays in the background; progress is the Restore row (kind
  // PITR, listed under this database) and the new database's status.
  getPitrWindow(dbId: string) {
    return apiFetch<PitrWindow>(`/databases/${dbId}/pitr/window`);
  },
  pitrRestoreToTime(dbId: string, input: { targetTime: string; name?: string; environmentId?: string }) {
    return apiFetch<{ restoreId: string; databaseId: string }>(`/databases/${dbId}/pitr/restore`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  // ── fleet rollouts ──
  listRollouts(filter: { teamId?: string | null; status?: string } = {}) {
    const qs = new URLSearchParams();
    if (filter.teamId) qs.set("teamId", filter.teamId);
    if (filter.status) qs.set("status", filter.status);
    const q = qs.toString();
    return apiFetch<Rollout[]>(`/rollouts${q ? `?${q}` : ""}`);
  },
  getRollout(id: string) {
    return apiFetch<Rollout>(`/rollouts/${id}`);
  },
  planRollout(input: RolloutCreateInput) {
    return apiFetch<RolloutPlan>("/rollouts/plan", { method: "POST", body: JSON.stringify(input) });
  },
  createRollout(input: RolloutCreateInput) {
    return apiFetch<Rollout>("/rollouts", { method: "POST", body: JSON.stringify(input) });
  },
  haltRollout(id: string) {
    return apiFetch<Rollout>(`/rollouts/${id}/halt`, { method: "POST" });
  },
  resumeRollout(id: string) {
    return apiFetch<Rollout>(`/rollouts/${id}/resume`, { method: "POST" });
  },
  cancelRollout(id: string) {
    return apiFetch<Rollout>(`/rollouts/${id}/cancel`, { method: "POST" });
  },
  rollbackRollout(id: string) {
    return apiFetch<Rollout>(`/rollouts/${id}/rollback`, { method: "POST" });
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
    return apiFetch<CreatedDestination>("/backup-destinations", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  updateDestination(id: string, input: {
    name?: string;
    s3Bucket?: string;
    s3Region?: string | null;
    s3Endpoint?: string;
    s3AccessKey?: string;
    s3SecretKey?: string;
    s3Prefix?: string | null;
    encryptionEnabled?: boolean;
  }) {
    return apiFetch<BackupDestination>(`/backup-destinations/${id}`, { method: "PUT", body: JSON.stringify(input) });
  },
  // An encrypted destination that still has backups 409s unless discardBackups is true (deleting it destroys the key).
  deleteDestination(id: string, opts?: { discardBackups?: boolean }) {
    return apiFetch<{ ok: true }>(`/backup-destinations/${id}${opts?.discardBackups ? "?discardBackups=true" : ""}`, { method: "DELETE" });
  },
  testDestination(id: string) {
    return apiFetch<DestinationTestResult>(`/backup-destinations/${id}/test`, { method: "POST" });
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
  renameApiToken(id: string, name: string) {
    return apiFetch<ApiToken>(`/api-tokens/${id}`, { method: "PATCH", body: JSON.stringify({ name }) });
  },
  rotateApiToken(id: string) {
    return apiFetch<{ token: string; view: ApiToken }>(`/api-tokens/${id}/rotate`, { method: "POST" });
  },
  deleteApiToken(id: string) {
    return apiFetch<{ ok: true }>(`/api-tokens/${id}`, { method: "DELETE" });
  },

  // ── fleet importer (Coolify / Dokploy / local-docker) ──
  // Store an encrypted, short-lived connection to a source PaaS (the token is never returned/logged).
  importConnect(input: { sourceKind: ImportRemoteKind; teamId: string; baseUrl: string; token: string; scopeLabel?: string }) {
    return apiFetch<ImportSession>("/import/connect", { method: "POST", body: JSON.stringify(input) });
  },
  // The hub's public egress IP for the wizard ("add this to the source's Allowed IPs"); `ip: null` = unknown, never guessed.
  importEgressIp() {
    return apiFetch<ImportEgressIp>("/import/egress-ip");
  },
  // Dry-run preview (secret-free) — local server to adopt, or a connected remote session.
  importPlan(input: { sourceKind: "local-docker"; serverId: string } | { sourceKind: ImportRemoteKind; sessionId: string; dbDataModes?: Record<string, "volume"> }) {
    return apiFetch<ImportPlan>("/import/plan", { method: "POST", body: JSON.stringify(input) });
  },
  // Apply a reviewed plan (planHash binds it to that exact preview). A remote apply may carry an editable mapping
  // (+ the mappingHash resolve returned for exactly it); the hub echoes `mappingApplied`, so a caller can catch a
  // hub that silently ignored the mapping (the review step does).
  importApply(
    input:
      | { sourceKind: "local-docker"; serverId: string; planHash: string }
      | {
          sourceKind: ImportRemoteKind;
          sessionId: string;
          targetServerId: string;
          environmentId?: string;
          planHash: string;
          acks?: ImportAck[];
          serviceChoices?: Record<string, ImportServiceChoice>;
          mapping?: ImportMappingDoc;
          mappingHash?: string;
          reconcile?: boolean;
          ignoreStoredMapping?: boolean;
          saveMapping?: boolean;
          dbDataModes?: Record<string, "volume">;
          /** Multi-host placement: source server ref to Tugra server id (same team as `targetServerId`, which stays the default). */
          serverMap?: Record<string, string>;
        },
  ) {
    return apiFetch<{ opId: string; mappingApplied?: boolean }>("/import/apply", { method: "POST", body: JSON.stringify(input) });
  },
  // Authoritative mapping preview: effective names/placement, every conflict, and the mappingHash apply must carry.
  importResolve(input: { sessionId: string; sourceKind: ImportRemoteKind; planHash: string; targetServerId: string; environmentId?: string; reconcile?: boolean; acks?: ImportAck[]; dbDataModes?: Record<string, "volume">; serverMap?: Record<string, string>; mapping: ImportMappingDoc }) {
    return apiFetch<ImportResolved>("/import/mapping/resolve", { method: "POST", body: JSON.stringify(input) });
  },
  importMappingGet(sessionId: string) {
    return apiFetch<ImportStoredMapping>(`/import/sessions/${encodeURIComponent(sessionId)}/mapping`);
  },
  importMappingPut(sessionId: string, input: { mapping: ImportMappingDoc; label?: string; expectedVersion?: number }) {
    return apiFetch<{ ok: true; version: number; mappingHash: string }>(`/import/sessions/${encodeURIComponent(sessionId)}/mapping`, { method: "PUT", body: JSON.stringify(input) });
  },
  importMappingDelete(sessionId: string) {
    return apiFetch<{ ok: true; deleted: boolean }>(`/import/sessions/${encodeURIComponent(sessionId)}/mapping`, { method: "DELETE" });
  },
  // Resolve how each git app of the connected source would be linked on the target server's team (read-only).
  importGitLinks(input: { sessionId: string; targetServerId: string }) {
    return apiFetch<ImportGitLinksView>("/import/git-links", { method: "POST", body: JSON.stringify(input) });
  },
  // After an import: link the created apps that a connected source now covers (choices pick a source for ambiguous apps).
  relinkImportGit(opId: string, choices?: Record<string, string>) {
    return apiFetch<{ results: ImportRelinkResult[]; linked: number }>(`/import/operations/${encodeURIComponent(opId)}/git-links/relink`, { method: "POST", body: JSON.stringify(choices && Object.keys(choices).length ? { choices } : {}) });
  },
  // Preview the SERVICE import (read-only, secret-free): per service its verdict, members, variable names, volumes, domains.
  previewImportServices(input: { sessionId: string; sourceKind?: ImportRemoteKind; choices?: Record<string, ImportServiceChoice> }) {
    return apiFetch<{ services: ImportServicePreview[] }>("/import/services/preview", { method: "POST", body: JSON.stringify(input) });
  },
  getImportOperation(opId: string) {
    return apiFetch<ImportOperation>(`/import/operations/${encodeURIComponent(opId)}`);
  },
  cancelImport(opId: string) {
    return apiFetch<ImportOperation>(`/import/operations/${encodeURIComponent(opId)}/cancel`, { method: "POST" });
  },
  rollbackImport(opId: string) {
    return apiFetch<ImportOperation>(`/import/operations/${encodeURIComponent(opId)}/rollback`, { method: "POST" });
  },
  // ── post-import: SSL/DNS cutover (Cloudflare-managed hosts are flipped by the hub; manual DNS gets copy-paste records) ──
  getCutover(opId: string) {
    return apiFetch<CutoverView>(`${cutoverBase(opId)}`);
  },
  cutoverInit(opId: string, body: { dnsCredentialId?: string } = {}) {
    return cutoverPost<CutoverView>(opId, "/init", body);
  },
  cutoverCertPrepare(opId: string, body: { hostnames?: string[]; challenge: "dns01" | "http01" }) {
    return cutoverPost<{ blocked: Array<{ hostname: string; reason: string }>; view: CutoverView }>(opId, "/cert-prepare", body);
  },
  cutoverCheck(opId: string, body: { hostnames?: string[]; probeVia?: "hub" | "agent"; healthPath?: string } = {}) {
    return cutoverPost<CutoverView>(opId, "/check", body);
  },
  cutoverTtl(opId: string, body: { hostnames?: string[]; ttl?: number } = {}) {
    return cutoverPost<{ guidance: CutoverTtlGuidance[]; view: CutoverView }>(opId, "/ttl", body);
  },
  getCutoverFlipPlan(opId: string, q: CutoverFlipPlanQuery = {}) {
    const p = new URLSearchParams();
    if (q.hostnames && q.hostnames.length > 0) p.set("hostnames", q.hostnames.join(","));
    if (q.targetTtl !== undefined) p.set("targetTtl", String(q.targetTtl));
    if (q.keepProxied !== undefined) p.set("keepProxied", q.keepProxied ? "true" : "false");
    const qs = p.toString();
    return apiFetch<CutoverFlipPlan>(`${cutoverBase(opId)}/flip-plan${qs ? `?${qs}` : ""}`);
  },
  cutoverFlip(opId: string, body: CutoverFlipInput) {
    return cutoverPost<{ runId: string; planHash: string; queued: boolean }>(opId, "/flip", body);
  },
  cutoverCancel(opId: string) {
    return cutoverPost<CutoverView>(opId, "/cancel");
  },
  cutoverFinalize(opId: string, body: { hostnames?: string[] } = {}) {
    return cutoverPost<CutoverView>(opId, "/finalize", body);
  },
  cutoverRevert(opId: string, body: { hostnames: string[]; force?: boolean; acknowledgeDataLoss: true }) {
    return cutoverPost<CutoverView>(opId, "/revert", body);
  },
  cutoverFixCounterpart(opId: string, body: { applicationId: string; direction: "root" | "www" }) {
    return cutoverPost<CutoverView>(opId, "/fix-counterpart", body);
  },
  cutoverExclude(opId: string, body: { hostnames: string[]; excluded: boolean }) {
    return cutoverPost<CutoverView>(opId, "/exclude", body);
  },
  cutoverSeedCerts(opId: string, body: { serverId?: string; acknowledgeProxyRestart: boolean }) {
    return cutoverPost<{ applied: number; view: CutoverView }>(opId, "/seed-certs", body);
  },

  // ── post-import: database-data migration (one-liner pasted on the source host) ──
  // Read-only state + a command TEMPLATE (never the live token); the live command is returned once by mint.
  getMigrateCommand(opId: string) {
    return apiFetch<MigrateCommand>(`/import/operations/${encodeURIComponent(opId)}/migrate-command`);
  },
  // Mint (or rotate) the one-time migration token; the full command is shown ONCE and the token is hashed at rest.
  mintMigrationToken(opId: string) {
    return apiFetch<MintedMigrationToken>(`/import/operations/${encodeURIComponent(opId)}/migration-token`, { method: "POST" });
  },
  reissueMigrationToken(opId: string) {
    return apiFetch<MintedMigrationToken>(`/import/operations/${encodeURIComponent(opId)}/migration-token/reissue`, { method: "POST" });
  },
  // ── post-import: streamed volume data (progress, dry-run inventory, abort / reset / explicit exclusion) ──
  getOpVolumes(opId: string) {
    return apiFetch<OpVolumes>(`/import/operations/${encodeURIComponent(opId)}/volumes`);
  },
  abortOpVolume(opId: string, itemRef: string) {
    return apiFetch<{ state: string }>(`/import/operations/${encodeURIComponent(opId)}/volumes/${encodeURIComponent(itemRef)}/abort`, { method: "POST" });
  },
  resetOpVolume(opId: string, itemRef: string) {
    return apiFetch<{ state: string; attempt?: number }>(`/import/operations/${encodeURIComponent(opId)}/volumes/${encodeURIComponent(itemRef)}/reset`, { method: "POST" });
  },
  diskCheckOpVolume(opId: string, itemRef: string, rawBytes?: number) {
    return apiFetch<VxDiskVerdict>(`/import/operations/${encodeURIComponent(opId)}/volumes/${encodeURIComponent(itemRef)}/disk-check`, { method: "POST", body: JSON.stringify(rawBytes === undefined ? {} : { rawBytes }) });
  },
  excludeOpVolume(opId: string, itemRef: string, reason?: string) {
    return apiFetch<{ itemRef: string; excluded: boolean }>(`/import/operations/${encodeURIComponent(opId)}/volumes/${encodeURIComponent(itemRef)}/exclude`, { method: "POST", body: JSON.stringify({ acknowledge: true, ...(reason ? { reason } : {}) }) });
  },
  includeOpVolume(opId: string, itemRef: string) {
    return apiFetch<{ itemRef: string; excluded: boolean }>(`/import/operations/${encodeURIComponent(opId)}/volumes/${encodeURIComponent(itemRef)}/include`, { method: "POST" });
  },
  // ── post-import: env remap (point migrated apps at their new Tugra databases) ──
  remapEnvPlan(opId: string) {
    return apiFetch<ImportRemapPlan>(`/import/operations/${encodeURIComponent(opId)}/remap-env/plan`);
  },
  remapEnvApply(opId: string, confirmToken: string) {
    return apiFetch<ImportRemapResult>(`/import/operations/${encodeURIComponent(opId)}/remap-env`, { method: "POST", body: JSON.stringify({ confirmToken }) });
  },
  remapEnvUndo(opId: string) {
    return apiFetch<ImportRemapResult>(`/import/operations/${encodeURIComponent(opId)}/remap-env/undo`, { method: "POST" });
  },

  // ── object (S3/MinIO) migration: mc mirror run by the target server's agent. No response carries a credential. ──
  listObjectMigrations(teamId?: string) {
    return apiFetch<ObjectMigrationView[]>(`/object-migrations${teamId ? `?teamId=${encodeURIComponent(teamId)}` : ""}`);
  },
  getObjectMigration(id: string) {
    return apiFetch<ObjectMigrationView>(`/object-migrations/${encodeURIComponent(id)}`);
  },
  createObjectMigration(input: CreateObjectMigrationInput) {
    return apiFetch<ObjectMigrationView>("/object-migrations", { method: "POST", body: JSON.stringify(input) });
  },
  preflightObjectMigration(id: string) {
    return apiFetch<ObjectMigrationView>(`/object-migrations/${encodeURIComponent(id)}/preflight`, { method: "POST" });
  },
  setObjectMigrationBuckets(id: string, buckets: Array<{ srcBucket: string; dstBucket?: string; selected: boolean; exclude?: string[] }>) {
    return apiFetch<ObjectMigrationView>(`/object-migrations/${encodeURIComponent(id)}/buckets`, { method: "PUT", body: JSON.stringify({ buckets }) });
  },
  startObjectMigration(id: string, input: StartObjectMigrationInput) {
    return apiFetch<ObjectMigrationView>(`/object-migrations/${encodeURIComponent(id)}/start`, { method: "POST", body: JSON.stringify(input) });
  },
  verifyObjectMigration(id: string) {
    return apiFetch<ObjectMigrationView>(`/object-migrations/${encodeURIComponent(id)}/verify`, { method: "POST" });
  },
  carryObjectMigrationConfig(id: string) {
    return apiFetch<ObjectMigrationView>(`/object-migrations/${encodeURIComponent(id)}/carry-config`, { method: "POST" });
  },
  cancelObjectMigration(id: string) {
    return apiFetch<ObjectMigrationView>(`/object-migrations/${encodeURIComponent(id)}/cancel`, { method: "POST" });
  },
  deleteObjectMigration(id: string) {
    return apiFetch<{ ok: true }>(`/object-migrations/${encodeURIComponent(id)}`, { method: "DELETE" });
  },

  // ── P7 guided migration runs (Coolify -> Tugra orchestrator; secret-free views, codes + params only) ──
  listMigrationRuns(filter: { teamId?: string | null; status?: MigrationRunStatus; active?: boolean; campaign?: string; limit?: number } = {}) {
    const p = new URLSearchParams();
    if (filter.teamId) p.set("teamId", filter.teamId);
    if (filter.status) p.set("status", filter.status);
    if (filter.active !== undefined) p.set("active", String(filter.active));
    if (filter.campaign) p.set("campaign", filter.campaign);
    if (filter.limit) p.set("limit", String(filter.limit));
    const q = p.toString();
    return apiFetch<MigrationRunSummary[]>(`/migration-runs${q ? `?${q}` : ""}`);
  },
  getMigrationRun(id: string) {
    return apiFetch<MigrationRunView>(`/migration-runs/${encodeURIComponent(id)}`);
  },
  getMigrationRunEvents(id: string, afterSeq = 0, limit = 200) {
    return apiFetch<MigrationRunEventsPage>(`/migration-runs/${encodeURIComponent(id)}/events?afterSeq=${afterSeq}&limit=${limit}`);
  },
  createMigrationRun(input: MigrationRunCreateInput) {
    return apiFetch<MigrationRunView>("/migration-runs", { method: "POST", body: JSON.stringify(input) });
  },
  /** QUEUED -> RUNNING; on a DRY_RUN_DONE run it promotes and returns a NEW run (its id differs). */
  startMigrationRun(id: string, body: { sessionId?: string } = {}) {
    return apiFetch<MigrationRunView>(`/migration-runs/${encodeURIComponent(id)}/start`, { method: "POST", body: JSON.stringify(body) });
  },
  approveMigrationRunStep(id: string, key: MigrationRunStepKey, body: MigrationRunApproveInput) {
    return apiFetch<MigrationRunView>(`/migration-runs/${encodeURIComponent(id)}/steps/${key}/approve`, { method: "POST", body: JSON.stringify(body) });
  },
  retryMigrationRunStep(id: string, key: MigrationRunStepKey) {
    return apiFetch<MigrationRunView>(`/migration-runs/${encodeURIComponent(id)}/steps/${key}/retry`, { method: "POST", body: JSON.stringify({}) });
  },
  skipMigrationRunStep(id: string, key: MigrationRunStepKey, body: { reason?: string } = {}) {
    return apiFetch<MigrationRunView>(`/migration-runs/${encodeURIComponent(id)}/steps/${key}/skip`, { method: "POST", body: JSON.stringify(body) });
  },
  attestMigrationRunStep(id: string, key: MigrationRunStepKey, body: { checkId: string; subject?: string; note?: string }) {
    return apiFetch<MigrationRunView>(`/migration-runs/${encodeURIComponent(id)}/steps/${key}/evidence`, { method: "POST", body: JSON.stringify(body) });
  },
  attachMigrationRunStep(id: string, key: MigrationRunStepKey, body: { kind: "object-migration"; resourceId: string }) {
    return apiFetch<MigrationRunView>(`/migration-runs/${encodeURIComponent(id)}/steps/${key}/attach`, { method: "POST", body: JSON.stringify(body) });
  },
  /** Mints (or reissues) the migrator token; the command carrying it is returned ONCE. */
  migrationRunCommand(id: string, key: MigrationRunStepKey, body: { reissue?: boolean; kind?: MigrationRunCommandKind } = {}) {
    return apiFetch<MigrationRunCommandResult>(`/migration-runs/${encodeURIComponent(id)}/steps/${key}/command`, { method: "POST", body: JSON.stringify(body) });
  },
  setMigrationRunInputs(id: string, body: MigrationRunInputsRequest) {
    return apiFetch<MigrationRunView>(`/migration-runs/${encodeURIComponent(id)}/inputs`, { method: "POST", body: JSON.stringify(body) });
  },
  pauseMigrationRun(id: string) {
    return apiFetch<MigrationRunView>(`/migration-runs/${encodeURIComponent(id)}/pause`, { method: "POST" });
  },
  resumeMigrationRun(id: string) {
    return apiFetch<MigrationRunView>(`/migration-runs/${encodeURIComponent(id)}/resume`, { method: "POST" });
  },
  abortMigrationRun(id: string, body: { confirmName: string }) {
    return apiFetch<MigrationRunView>(`/migration-runs/${encodeURIComponent(id)}/abort`, { method: "POST", body: JSON.stringify(body) });
  },
  cleanupMigrationRun(id: string, body: { confirmName: string; includeData?: boolean; dataConfirmNames?: string[] }) {
    return apiFetch<MigrationRunView>(`/migration-runs/${encodeURIComponent(id)}/cleanup`, { method: "POST", body: JSON.stringify(body) });
  },
  reverseMigrationRun(id: string, body: { confirmName: string; acknowledgeDataLoss: true }) {
    return apiFetch<MigrationRunView>(`/migration-runs/${encodeURIComponent(id)}/reverse`, { method: "POST", body: JSON.stringify(body) });
  },
  decommissionMigrationRun(id: string, body: { confirmName: string }) {
    return apiFetch<MigrationRunView>(`/migration-runs/${encodeURIComponent(id)}/decommission`, { method: "POST", body: JSON.stringify(body) });
  },
  /** Re-enter the source token when the 1 h import session expired (never returned). */
  migrationRunSourceSession(id: string, body: { token: string }) {
    return apiFetch<{ sessionId: string; expiresAt: string }>(`/migration-runs/${encodeURIComponent(id)}/source-session`, { method: "POST", body: JSON.stringify(body) });
  },
  getMigrationRunSafetyHints(id: string) {
    return apiFetch<MigrationRunSafetyHints>(`/migration-runs/${encodeURIComponent(id)}/safety-hints`);
  },
  /** Record (or, with `digest: null`, remove) the digest the SOURCE runs for a floating image. */
  setMigrationRunImagePins(id: string, body: { pins: Array<{ image: string; scope?: string; digest: string | null; evidence?: "operator-attested" | "host-loop-reported" }> }) {
    return apiFetch<MigrationRunSafetyHints>(`/migration-runs/${encodeURIComponent(id)}/image-pins`, { method: "PUT", body: JSON.stringify(body) });
  },
  /** Mark an app a job runner (held until after the cutover) or a web app; `role: null` removes the mark. */
  setMigrationRunWorkerMarks(id: string, body: { marks: Array<{ itemRef: string; role: "job-runner" | "web" | null }> }) {
    return apiFetch<MigrationRunSafetyHints>(`/migration-runs/${encodeURIComponent(id)}/worker-marks`, { method: "PUT", body: JSON.stringify(body) });
  },
  /** Accept (or take back) warnings of a finished dry run; the promoted run reads them from it. */
  setMigrationRunWarningAcks(id: string, body: { acks: Array<{ key: string; accepted: boolean }> }) {
    return apiFetch<MigrationRunSafetyHints>(`/migration-runs/${encodeURIComponent(id)}/warning-acks`, { method: "PUT", body: JSON.stringify(body) });
  },
  getMigrationRunReport(id: string) {
    return apiFetch<MigrationRunReport>(`/migration-runs/${encodeURIComponent(id)}/report`);
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
