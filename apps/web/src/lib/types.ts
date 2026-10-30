export type Role = "OWNER" | "ADMIN" | "VIEWER";
export type ServerStatus = "PENDING" | "ONLINE" | "OFFLINE";
export type ProxyStatus = "running" | "stopped" | "absent";

export interface TunnelView {
  configured: boolean;
  provider: string | null;
  zoneName: string | null;
  wildcardDomain: string | null;
  tunnelId: string | null;
  status: string | null;
  lastError: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface Team {
  id: string;
  name: string;
  role: Role;
  memberCount?: number;
}

export interface TeamMember {
  userId: string;
  email: string;
  name: string | null;
  role: Role;
  teamRoleId: string | null;
  roleName: string | null; // the assigned custom role's name, when one is set
  restrictedAccess: boolean;
  accessedProjects: string[];
}

// The granular resource permissions a custom role can grant (mirrors @tugra/shared TEAM_PERMISSIONS).
export const TEAM_PERMISSIONS = [
  "apps:deploy",
  "apps:config",
  "databases",
  "backups",
  "servers:manage",
  "servers:ops",
  "terminal",
  "bulk",
  "monitors",
  "projects",
  "integrations",
  "variables",
] as const;
export type TeamPermission = (typeof TEAM_PERMISSIONS)[number];

export interface TeamRole {
  id: string;
  name: string;
  permissions: string[];
}

export interface TeamInvitation {
  id: string;
  email: string;
  role: Role;
  token: string;
  expiresAt: string;
}

export interface MyInvitation {
  token: string;
  teamName: string;
  role: Role;
  expiresAt: string;
}

export interface InvitationPreview {
  teamName: string;
  inviterName: string | null;
  role: Role;
  email: string;
  expiresAt: string;
  expired: boolean;
}

export interface PublicUser {
  id: string;
  email: string;
  name: string | null;
  twoFaEnabled: boolean;
  emailVerified: boolean;
  uiMode: "fleet" | "home";
  /** First registered user / sole owner of this self-hosted instance — gates owner-only UI. */
  isInstanceOwner: boolean;
}

/** A server group (cluster) — fleet organization. */
export interface Cluster {
  id: string;
  teamId: string;
  name: string;
  description: string | null;
  nodeCount: number;
  swarmStatus: SwarmStatus;
  canWrite: boolean;
  createdAt: string;
}
export interface ClusterHealth {
  nodes: { online: number; offline: number; pending: number; total: number };
  apps: { running: number; stopped: number; failed: number; new: number; total: number };
}
export interface ClusterServerView {
  id: string;
  name: string;
  status: string;
  hostname: string | null;
  publicIp: string | null;
}
export interface ClusterDetail extends Cluster {
  servers: ClusterServerView[];
  health: ClusterHealth;
}

// ── Docker Swarm formation ──
export type SwarmStatus = "NONE" | "FORMING" | "ACTIVE" | "DEGRADED" | "DISSOLVING" | "JOINING";

/** One swarm task (replica) in the live cluster-deploy panel. */
export interface SwarmTask {
  slot: string;
  node: string;
  desiredState: string;
  currentState: string;
  error: string;
}
/** Live replica status for a swarm-deployed app. `reachable:false` = the manager could not be queried. */
export interface AppClusterStatus {
  desired: number;
  running: number;
  reachable: boolean;
  tasks: SwarmTask[];
}
export type SwarmRole = "MANAGER" | "WORKER";
export interface SwarmNodeView {
  serverId: string;
  name: string;
  status: string;
  swarmRole: SwarmRole | null;
  swarmError: string | null;
  swarmCapable: boolean;
  swarmNodeId: string | null;
}
export interface SwarmLiveNode {
  id: string;
  hostname: string;
  role: string;
  state: string;
  availability: string;
  labels: Record<string, string>;
}

/** A structured Swarm placement rule. */
export type PlacementConstraint =
  | { type: "hostname"; op: "eq" | "ne"; value: string }
  | { type: "nodeId"; op: "eq" | "ne"; value: string }
  | { type: "role"; op: "eq" | "ne"; value: "manager" | "worker" }
  | { type: "label"; op: "eq" | "ne"; key: string; value: string };
export interface Placement {
  constraints: PlacementConstraint[];
  spreadLabelKey: string | null;
}
/** Raft manager-quorum health, derived live from the manager nodes' roles/status. */
export interface SwarmQuorum {
  managers: number;
  managersOnline: number;
  hasQuorum: boolean;
}
export interface SwarmView {
  clusterId: string;
  swarmStatus: SwarmStatus;
  managerServerId: string | null;
  swarmLastError: string | null;
  nodes: SwarmNodeView[];
  live: SwarmLiveNode[] | null;
  /** Manager-quorum health; null only when swarmStatus is NONE. */
  quorum: SwarmQuorum | null;
}

/** One node in the resolved swarm-ingress pool — point a DNS A record at each `ip` for failover. */
export interface IngressNode {
  id: string;
  name: string;
  ip: string | null;
}
export interface IngressView {
  replicas: number;
  nodes: IngressNode[];
}

/** Public onboarding state (GET /instance/status) — read before login to gate the welcome flow. */
export interface InstanceStatus {
  /** True once the first user has completed setup; false → a fresh install needs the owner account. */
  initialized: boolean;
  allowRegistration: boolean;
  edition: string;
  /** OIDC single sign-on is enabled + fully configured on a Pro+ edition → show the SSO login button. */
  ssoEnabled: boolean;
  /** The instance was installed with a first-run setup code and no owner has claimed it yet → the welcome
   *  form must ask for the code. Only the boolean is exposed, never the code. */
  setupCodeRequired?: boolean;
  /** The hub's public origin (HUB_PUBLIC_URL); empty when unset. Used for the terminal WS + webhook URLs. */
  hubPublicUrl?: string;
  /** Which SSO providers are CONFIGURED (booleans only, never secrets) — hide unconfigured buttons. */
  authProviders?: { github: boolean; oidc: boolean };
}

/** Owner license status (GET/PATCH /instance/license). The token is write-only (never returned) —
 *  only the effective plan, validity and expiry are surfaced. */
export interface LicenseStatus {
  /** The effective edition the instance runs as (env signal raised by a valid license). */
  plan: string;
  /** Whether a currently-valid signed license is active. */
  valid: boolean;
  /** License expiry (ISO) when valid, else null. */
  expiresAt: string | null;
  /** Where a token was found: "db" (owner-pasted), "env", or null when none is present. */
  source: "db" | "env" | null;
}

/** Owner OIDC (SSO) config (GET/PATCH /instance/oidc) — Pro edition. The client secret is write-only:
 *  never returned (`clientSecretSet` reveals only whether one is stored). */
export interface OidcConfig {
  oidcEnabled: boolean;
  oidcIssuer: string | null;
  oidcClientId: string | null;
  oidcAllowedDomains: string[];
  clientSecretSet: boolean;
}

/** Owner-configurable instance settings (GET/PATCH /instance/settings) — API gating + onboarding basics. */
export interface OwnerInstanceSettings {
  /** Master switch for token (PAT) API access; the web session is never affected. */
  apiEnabled: boolean;
  /** Single IPs and/or CIDR ranges a PAT may connect from; empty = any address. */
  apiAllowedIps: string[];
  /** Public base URL the agent dials back to (e.g. https://hub.example.com); null when unset. */
  publicUrl: string | null;
  /** Let's Encrypt account email used when issuing SSL certs; null when unset. */
  acmeEmail: string | null;
  /** Read-only env/license edition (surfaced by GET, never PATCHable). */
  edition?: string;
}

/** Self-update status (GET /instance/update, PATCH .../update, POST .../update/check). Owner-only. */
export interface InstanceUpdateStatus {
  /** The running hub version. */
  current: string;
  /** Latest published version for the tracked channel (from the last signed check); null until checked. */
  latest: string | null;
  /** The release channel being tracked ("stable" | "beta" | …). */
  channel: string;
  /** Whether `latest` is strictly newer than `current` (never a downgrade). */
  updateAvailable: boolean;
  /** Link to the release notes, or null. */
  changelogUrl: string | null;
  /** Whether patch releases are applied automatically (the updater is not yet available). */
  autoUpdate: boolean;
}

/** Result of POST /instance/update (starting the updater). `started` = queued for the sidecar. */
export interface InstanceUpdateApply {
  status: "started" | "up-to-date" | "in-progress" | "unconfigured" | "error" | "notify-only" | "needs-intermediate";
  targetVersion: string | null;
}

/** The exact anonymous payload sent to the telemetry endpoint — mirrored to the UI so what is shown is
 *  byte-for-byte what is sent. Only coarse aggregates + build metadata under a random id; no PII. */
export interface TelemetryPayload {
  instanceId: string;
  version: string;
  channel: string;
  edition: string;
  platform: string;
  arch: string;
  nodeMajor: number;
  counts: {
    servers: number;
    applications: number;
    databases: number;
    deployments: number;
    teams: number;
    users: number;
    clusters: number;
    monitors: number;
    containers: number;
  };
  sentAt: string;
}

/** Public white-label branding (GET /instance/branding). All null + hidePoweredBy=false → the Tugra
 *  defaults. Only applied while the instance is Pro+ (the server returns defaults below Pro). */
export interface Branding {
  name: string | null;
  logoUrl: string | null;
  faviconUrl: string | null;
  accentColor: string | null;
  hidePoweredBy: boolean;
}

/** Control-panel HTTPS status (GET /instance/panel-tls, DİLİM 1). Owner-only. */
export interface PanelTlsStatus {
  enabled: boolean;
  domain: string | null;
  resolver: string | null; // "le" | "le-dns" | null
  originHost: string | null;
  originMatches: boolean;
  acmeEmailOk: boolean;
  localServerId: string | null;
  localServerOnline: boolean;
  proxyRunning: boolean;
  routerPresent: boolean;
}

/** Anonymous usage stats status (GET /instance/telemetry). Owner-only. On by default, opt-out. */
export interface TelemetryStatus {
  /** Effective state: on AND not env-forced-off. */
  enabled: boolean;
  /** TUGRA_TELEMETRY=0 — a deployment hard-off; the owner toggle is then inert. */
  forcedOff: boolean;
  /** The raw owner-UI toggle value (telemetryEnabled), shown even when forcedOff. */
  dbEnabled: boolean;
  /** The anonymous instance id; null until first minted. */
  instanceId: string | null;
  /** Last successful send (ISO), or null. */
  lastSentAt: string | null;
  /** Send cadence in minutes. */
  intervalMin: number;
  /** Where the stats are sent. */
  endpoint: string;
  /** A live preview of exactly what would be sent. */
  payload: TelemetryPayload;
}

export interface ServerView {
  id: string;
  name: string;
  status: ServerStatus;
  teamId: string;
  clusterId: string | null; // the cluster this server belongs to (null = standalone)
  clusterName: string | null; // resolved on the detail view; null in list views
  hostname: string | null;
  publicIp: string | null;
  publicIpv6: string | null;
  ipSource: string;
  wildcardDomain: string | null;
  magicSuffix: string | null;
  certMode: string;
  dnsProvider: string | null;
  customCertResolver: string | null;
  hasDnsCreds: boolean;
  os: string | null;
  osVersion: string | null;
  arch: string | null;
  kernel: string | null;
  agentVersion: string | null;
  cpuCores: number | null;
  memTotalBytes: string | null;
  uptimeSeconds: number | null;
  cleanupEnabled: boolean;
  cleanupIntervalHours: number | null;
  cleanupCron: string | null;
  cleanupThresholdPct: number | null;
  cleanupVolumes: boolean;
  lastCleanupAt: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  seal: string | null;
  tags: string[];
  capabilities: string[]; // granted agent capabilities; [] = all
  isLocal: boolean; // the box the hub runs on (auto-provisioned on a turnkey single-box install)
  proxyBind: string; // how the reverse proxy publishes :80/:443 — "public" | "loopback" | "none"
  provider: string | null; // cloud provider that created this VM (null = manually enrolled)
  providerServerId: string | null; // provider-side id (present once created; enables destroy-VM)
  canWrite: boolean;
}

// A team's cloud-provider API credential. The token itself is never returned.
export interface CloudCredential {
  id: string;
  name: string;
  teamId: string;
  provider: string;
  createdAt: string;
  canWrite: boolean;
}

// A team's DNS-provider API credential (Cloudflare) for one-click custom-domain setup. The token is never returned.
export interface DnsCredential {
  id: string;
  name: string;
  teamId: string;
  provider: string;
  cfAccountId: string | null;
  lastVerifiedAt: string | null;
  createdAt: string;
  canWrite: boolean;
}

// A row in an auto-setup result. In a dry run it carries content/proxied/action (create|update|noop|delete|
// conflict); after an apply it carries recordId/action (created|updated|kept|deleted).
export interface DnsAutoSetupRecord {
  type: string;
  name: string;
  content?: string;
  proxied?: boolean;
  action: string;
  recordId?: string;
  existingId?: string | null;
}

// Result of POST /apps/:id/domain/auto-setup, discriminated by dryRun.
export interface DnsAutoSetupResult {
  dryRun: boolean;
  hostname: string;
  apex?: boolean;
  sslMode?: string;
  status?: string;
  records: DnsAutoSetupRecord[];
}

// The copy-paste records for a manual DNS setup at any provider.
export interface DnsManualRecords {
  hostname: string;
  records: Array<{ type: string; name: string; content: string }>;
}

// The drain targets the agent can ship to (http = Tugra batch JSON, loki = Grafana Loki push,
// datadog = Datadog intake). Adding more needs agent-side shipping support, not just this list.
export type LogDrainType = "http" | "loki" | "datadog";

export interface LogDrain {
  id: string;
  name: string;
  type: string;
  endpoint: string;
  enabled: boolean;
  hasToken: boolean;
  createdAt: string;
}

export interface UpgradablePackage {
  name: string;
  current: string;
  candidate: string;
}

export interface PatchInfo {
  supported: boolean;
  manager: string | null; // apt | dnf | yum | apk — the package manager detected on the server
  checkFailed: boolean; // the update check ran but errored (repo unreachable / bad GPG) — not "up to date"
  rebootRequired: boolean;
  packages: UpgradablePackage[];
  count: number;
}

// Fleet-wide OS patching across many servers at once (non-writable servers are skipped, not errored).
export interface FleetPatchCheckRow {
  serverId: string;
  online: boolean; // false → the agent wasn't connected, so no check ran
  updates?: PatchInfo;
  error?: string;
}
export interface FleetPatchApplyRow {
  serverId: string;
  online: boolean;
  exitCode?: number; // 0 → applied cleanly
  error?: string;
}
export interface FleetPatchCheckResult {
  results: FleetPatchCheckRow[];
  skipped: string[]; // server ids the caller can't write (cross-team / insufficient role / unknown)
}
export interface FleetPatchApplyResult {
  results: FleetPatchApplyRow[];
  skipped: string[];
}

// Signed, digest-pinned self-update of the Go agent (one server or a fleet). The target version/image/sha256
// come only from the hub's ed25519-verified release manifest — never the request.
export interface AgentUpdateItem {
  serverId: string;
  status: "sent" | "offline" | "skipped"; // sent = dispatched; the new version shows once the agent reconnects
  reason?: string; // skip reason: already-current | no-digest-for-arch | capability-not-granted | not-permitted
}
export interface AgentUpdateResponse {
  status: "ok" | "unconfigured" | "error"; // unconfigured = no signed manifest; error = couldn't verify it
  total: number;
  sent: number;
  offline: number;
  skipped: number;
  results: AgentUpdateItem[];
}

// Migrator discover/adopt: a foreign (non-Tugra) container found on a server.
export interface DiscoveredPort {
  host: number | null; // published host port, or null when only exposed
  container: number;
  protocol: "tcp" | "udp";
}
export interface DiscoveredEnv {
  key: string;
  value: string;
}
export interface DiscoveredMount {
  type: string;
  source: string;
  target: string;
}
export interface DiscoveredContainer {
  id: string;
  name: string;
  image: string;
  state: string;
  ports: DiscoveredPort[];
  env: DiscoveredEnv[];
  mounts: DiscoveredMount[];
  restartPolicy: string;
  isTugra: boolean;
  composeProject: string | null;
  adoptable: boolean; // false for compose-managed containers (v1 can't adopt those)
}

export interface MetricsSample {
  ts: number;
  cpu: number;
  memUsed: number;
  memTotal: number;
  diskUsed: number;
  diskTotal: number;
  netRx: number;
  netTx: number;
  diskRead: number;
  diskWrite: number;
  temp?: number;
  sensors?: Record<string, number>;
  gpus?: GpuStat[];
  battery?: BatterySample | null;
}

export interface GpuStat {
  name: string;
  util: number;
  memUsed: number;
  memTotal: number;
  temp?: number;
  power?: number;
}

export interface BatterySample {
  percent: number;
  state: string;
}

export type MetricsRange = "1h" | "6h" | "24h" | "7d";

/** One row of GET /fleet/metrics/latest: a server's newest sample, for the fleet overview table. */
export interface FleetLatestRow {
  serverId: string;
  sample: MetricsSample;
}

export interface ContainerMetricSample {
  ts: number;
  cpu: number;
  memUsed: number;
  memTotal: number;
  memPct: number;
  netRx: number;
  netTx: number;
  blkRead: number;
  blkWrite: number;
}

export interface AppContainerMetrics {
  containers: { name: string; samples: ContainerMetricSample[] }[];
}

export interface ContainerInventoryRow extends ContainerMetricSample {
  name: string;
  containerId: string;
  label: string; // friendly name ("WordPress · db", "hub-api") — show this, not the raw tugra_ name
  kind: "app" | "db" | "system" | "other";
  resourceId?: string;
  service?: string;
}

export interface ServerContainers {
  containers: ContainerInventoryRow[];
}

// Host-wide list INCLUDING stopped containers (live `docker ps -a`), so the Containers tab can show a
// stopped container and offer Start. No stats — state is docker's own (running/exited/created/paused/…).
export interface HostContainer {
  name: string;
  state: string;
  kind: "app" | "db" | "system" | "other";
  label: string;
  resourceId?: string;
}
export interface HostContainers {
  containers: HostContainer[];
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export type MonitorType = "HTTP" | "TCP" | "METRIC";
export type MonitorStatus = "UP" | "DOWN" | "PENDING";

export interface Monitor {
  id: string;
  name: string;
  type: MonitorType;
  target: string;
  serverId: string | null;
  metric: string | null;
  thresholdPct: number | null;
  status: MonitorStatus;
  intervalSec: number;
  retries: number;
  timeoutMs: number;
  resendEvery: number;
  enabled: boolean;
  auto: boolean;
  appId: string | null;
  channelIds: string[];
  teamId: string;
  role: Role;
  canWrite: boolean;
  createdAt: string;
}

export interface Heartbeat {
  ts: number;
  status: MonitorStatus;
  ms: number;
  msg: string | null;
  important: boolean;
}

export interface Channel {
  id: string;
  name: string;
  type: string;
  teamId: string;
  enabled: boolean;
  eventTypes: string[];
  canWrite: boolean;
}

export type DeliveryStatus = "PENDING" | "SENT" | "FAILED" | "DEAD";

/** A single notification-delivery attempt row (GET /channels/:id/deliveries). Read-only history:
 *  title/summary/level are the snapshot frozen at enqueue; lastError is server-side sanitized. */
export interface Delivery {
  id: string;
  channelId: string;
  event: string;
  level: string;
  title: string;
  summary: string;
  status: DeliveryStatus;
  attempts: number;
  lastError: string | null;
  createdAt: string; // ISO
  sentAt: string | null; // ISO
}

export interface AuditEntry {
  id: string;
  actor: string;
  action: string;
  target: string | null;
  meta: unknown;
  createdAt: string;
}

export interface AuditPage {
  entries: AuditEntry[];
  nextCursor: string | null;
}

export interface GitSource {
  id: string;
  name: string;
  teamId: string;
  provider: string;
  appId: string;
  appSlug: string | null;
  installationId: string | null;
  htmlUrl: string | null;
  createdAt: string;
  canWrite: boolean;
}

export interface SourceRepo {
  fullName: string;
  cloneUrl: string;
  private: boolean;
}

export interface Registry {
  id: string;
  name: string;
  teamId: string;
  type: string;
  url: string | null;
  username: string;
  imagePrefix: string | null;
  createdAt: string;
  canWrite: boolean;
}

export type BulkTaskStatus =
  | "PENDING"
  | "RUNNING"
  | "DONE"
  | "FAILED"
  | "SKIPPED";

export interface BulkTask {
  id: string;
  serverId: string;
  status: BulkTaskStatus;
  exitCode: number | null;
  output: string | null;
}

export interface BulkOperation {
  id: string;
  command: string;
  tasks: BulkTask[];
}

// ── importer (Coolify / local-docker fleet import) ──
export type ImportRiskLevel = "info" | "warn" | "blocker";
export interface ImportRisk {
  level: ImportRiskLevel;
  code: string;
  message: string;
}
export interface ImportPlanItem {
  itemRef: string;
  kind: "app" | "database" | "volume";
  name: string;
  proposed: Record<string, unknown>;
  risks: ImportRisk[];
  dependsOn: string[];
}
export interface ImportPlan {
  sourceKind: string;
  mode: "copy" | "takeover";
  items: ImportPlanItem[];
  totals: { apps: number; databases: number; volumes: number; blockers: number };
  warnings: string[];
  planHash: string;
}
/** The short-lived encrypted connection returned by import_connect. */
export interface ImportSession {
  sessionId: string;
  expiresAt: string;
}
export type ImportTaskStatus =
  | "PENDING" | "RUNNING" | "DONE" | "FAILED" | "SKIPPED" | "ROLLED_BACK" | "FAILED_VERIFY" | "AWAITING_CUTOVER" | "CANCELLED";
export interface ImportOpTask {
  itemRef: string | null;
  kind: string;
  name: string | null;
  status: ImportTaskStatus;
  resourceType: string | null;
  resourceId: string | null;
  message: string | null;
  unresolvedEnv?: number;
  startedAt: string | null;
  finishedAt: string | null;
}
export type ImportOpState = "RUNNING" | "SUCCEEDED" | "PARTIAL" | "FAILED" | "CANCELLED";
export interface ImportOperation {
  id: string;
  sourceKind: string | null;
  serverId: string | null;
  planHash: string | null;
  status: ImportOpState;
  cancelRequested: boolean;
  createdAt: string;
  totals: { total: number; done: number; failed: number; skipped: number; running: number; pending: number; cancelled: number; rolledBack: number };
  tasks: ImportOpTask[];
  /** The secret-free plan captured at apply time — the durable record of what the import found + intended. */
  plan?: ImportPlan | null;
}

// ── post-import: database-data migration (the one-liner pasted on the source host) ──
/** Read-only migration state + a command TEMPLATE (never a live token). */
export interface MigrateCommand {
  opId: string;
  active: boolean; // a token is currently live
  expiresAt: string | null;
  commandTemplate: string; // the command with a <token> placeholder (shown as guidance)
}
/** The minted token response — the full `command` is shown ONCE (the token is hashed at rest). */
export interface MintedMigrationToken {
  opId: string;
  token: string;
  expiresAt: string;
  command: string; // ready-to-paste one-liner carrying the live token
}

// ── post-import: env remap (point migrated apps at their new Tugra databases) ──
export interface RemapChange {
  key: string;
  rule: string;
  targetItemRef: string;
  targetName: string;
  targetKind: string;
  oldMasked: string;
  newMasked: string;
  confidence: string;
}
export interface RemapNeedsManual {
  key: string;
  reason: string;
  targetItemRef?: string;
}
export interface RemapAppDbNetwork {
  willLink: boolean;
  reason?: string;
  databases: string[];
  serverDbCount: number;
  hasUnauthEngine: boolean;
}
export interface RemapApp {
  itemRef: string;
  appId: string;
  name: string;
  changes: RemapChange[];
  unchangedCount: number;
  needsManual: RemapNeedsManual[];
  dbNetwork: RemapAppDbNetwork | null;
}
export interface RemapDatabase {
  itemRef: string;
  name: string;
  engine: string;
  mode: "preserve" | "rotate";
}
/** Secret-masked env-remap preview + the planHash the apply must confirm against. */
export interface ImportRemapPlan {
  opId: string;
  planHash: string;
  databases: RemapDatabase[];
  skipped: unknown[];
  apps: RemapApp[];
  note: string;
}
/** Result of applying (or undoing) the env remap — secret-free counts + keys. */
export interface ImportRemapResult {
  opId: string;
  applied?: boolean;
  undone?: boolean;
  planHash?: string;
  apps: { appId: string; name: string; written?: number; keys?: string[]; needsRedeploy?: boolean; linked?: boolean }[];
  failed: { appId: string; name: string }[];
  linkFailed?: { appId: string; name: string }[];
  note: string;
}

export type AppStatus = "NEW" | "RUNNING" | "STOPPED" | "FAILED";

export type AppSource = "IMAGE" | "GIT" | "COMPOSE";
export type BuildType = "NIXPACKS" | "DOCKERFILE" | "STATIC" | "RAILPACK" | "HEROKU";

export interface AppVolume {
  name: string;
  path: string;
}

export interface HostMount {
  hostPath: string;
  containerPath: string;
  readOnly?: boolean;
}

/** One entry in an app-volume file listing (metadata only — never content). */
export interface FileEntry {
  name: string;
  type: "file" | "dir" | "symlink" | "other";
  size: number;
  mode: string; // rwx permission string
  mtime: number; // unix seconds
}
export interface FileListing {
  entries: FileEntry[];
  truncated: boolean; // the folder had more entries than the agent's cap
}

export interface ScheduledTask {
  id: string;
  name: string;
  schedule: string;
  command: string;
  enabled: boolean;
  lastRunAt: string | null;
}

export interface ProjectResource {
  id: string;
  name: string;
  kind: "app" | "database";
  source: AppSource | null;
  status: string;
  url: string | null;
  serverName: string | null;
  tags: string[];
  engine: string | null;
  iconUpdatedAt: string | null;
  templateSlug: string | null;
  templateLogo: string | null;
}

export interface Environment {
  id: string;
  name: string;
  isDefault: boolean;
  appCount: number;
  dbCount: number;
  resources?: ProjectResource[];
  createdAt: string;
}

export interface Project {
  id: string;
  teamId: string;
  name: string;
  isDefault: boolean;
  environments: Environment[];
  role: Role;
  canWrite: boolean;
  createdAt: string;
}

export interface DomainView {
  id: string;
  appId: string;
  appStatus: AppStatus;
  teamId: string;
  name: string;
  domain: string;
  https: boolean;
  url: string | null;
  domainRedirect: "www" | "root" | null;
  securityHeaders: boolean;
  ssl: {
    state: "ok" | "expiring" | "error";
    daysRemaining: number | null;
    validTo: string | null;
    issuer: string | null;
  };
}

export interface Template {
  slug: string;
  name: string;
  description: string;
  category: string;
  icon?: string;
  logo?: string;
  documentation?: string;
  tagline?: string;
  tags?: string[];
  featured?: boolean;
  badges?: string[];
}

// Mirrors the hub's PublicManifest / FormField (apps/hub-api/src/templates/template-manifest.ts) —
// the typed install form is driven by these field definitions. It never carries resolved secret
// VALUES (resolution happens server-side at install); composeFile is present only when the caller can
// write to the ?serverId= team.
export type FieldType =
  | "text" | "password" | "number" | "boolean" | "email"
  | "url" | "fqdn" | "port" | "select" | "random" | "hidden";

export interface FormField {
  key: string;
  type: FieldType;
  label: string;
  hint?: string;
  required?: boolean;
  default?: string;
  min?: number;
  max?: number;
  regex?: string;
  options?: { value: string; label: string }[];
  generate?: string; // blank ⇒ the server generates it
  secret?: boolean;
}

export interface ExposePort {
  serviceName: string;
  containerPort: number;
  defaultMode: "domain" | "hostPort";
  public?: boolean;
}

export interface TemplateManifest extends Template {
  fields?: FormField[];
  exposure?: ExposePort[];
  variables?: Record<string, string>;
  mounts?: { serviceName: string; target: string; mode?: string }[];
  composeFile?: string; // only when the caller can write to the server's team
}

export interface AppConfigMount {
  serviceName: string;
  target: string;
  mode: string | null;
  content: string;
}

export interface Application {
  id: string;
  name: string;
  templateSlug: string | null;
  templateLogo: string | null;
  // ISO timestamp when a custom icon was last uploaded (null = no custom icon); cache-busts the icon URL.
  iconUpdatedAt: string | null;
  source: AppSource;
  image: string | null;
  gitUrl: string | null;
  gitBranch: string | null;
  gitSourceId: string | null;
  buildType: BuildType;
  buildCommand: string | null;
  dockerfilePath: string | null;
  baseDirectory: string | null;
  outputDir: string | null;
  composeFile: string | null;
  healthCmd: string | null;
  healthCheckType: string | null;
  healthCheckPath: string | null;
  healthCheckPort: number | null;
  memoryMb: number | null;
  cpus: number | null;
  reserveMemoryMb: number | null;
  reserveCpus: number | null;
  gpus: string | null;
  deployTimeoutSec: number | null;
  dockerOptions: string | null;
  // Pre/post-deploy hook commands (writer-only in the API → null for read-only members). Single-server apps.
  preDeployCommand: string | null;
  postDeployCommand: string | null;
  volumes: AppVolume[];
  hostMounts: HostMount[];
  // Named volumes a COMPOSE app declares (empty for non-compose); browsable=false → external/custom.
  composeVolumes: { key: string; browsable: boolean; mounts: { service: string; path: string }[] }[];
  hasConfigMounts: boolean;
  hasGitToken: boolean;
  hasGitSshKey: boolean;
  gitSshPublicKey: string | null;
  registryUrl: string | null;
  registryUser: string | null;
  registryId: string | null;
  pushToRegistry: boolean;
  buildServerId: string | null;
  clusterId: string | null;
  replicas: number | null;
  placement: Placement;
  constraintServerId: string | null;
  deployStrategy: string;
  rollbackOnFailure: boolean;
  zeroDowntime: boolean;
  environmentId: string;
  projectId: string | null;
  projectName: string | null;
  environmentName: string | null;
  serverId: string;
  teamId: string;
  status: AppStatus;
  hostPort: number | null;
  containerPort: number | null;
  domain: string | null;
  extraDomains: string[];
  domainRedirect: "www" | "root" | null;
  securityHeaders: boolean;
  forwardAuth: string | null;
  https: boolean;
  domainKind: string;
  exposeMode: string;
  tunnelExposed: boolean;
  certType: string;
  certDomains: string[];
  certNotAfter: string | null;
  hasCustomCert: boolean;
  url: string | null;
  webhookToken: string | null;
  webhookSecret: string | null;
  isPreview: boolean;
  previewEnabled: boolean;
  prNumber: number | null;
  parentAppId: string | null;
  tags: string[];
  volumeBackupEnabled: boolean;
  volumeBackupIntervalHours: number | null;
  volumeBackupRetention: number;
  volumeBackupDestinationId: string | null;
  envCount: number;
  canWrite: boolean;
  createdAt: string;
}

export interface VolumeBackup {
  id: string;
  volumeName: string;
  status: BackupStatus;
  filename: string;
  sizeBytes: string | null;
  destinationId: string | null; // set → stored on a destination
  destinationType: string | null; // "S3" | "LOCAL" | null — only an S3 backup can export a migration URL
  createdBy: string;
  createdAt: string;
  completedAt: string | null;
}

export type DeploymentStatus = "QUEUED" | "RUNNING" | "SUCCESS" | "FAILED" | "CANCELLED";

export interface HubBackupItem {
  id: string;
  status: string;
  filename: string;
  sizeBytes: string | null;
  errorTail: string | null;
  createdAt: string;
  completedAt: string | null;
}
export interface HubBackupView {
  enabled: boolean;
  intervalHours: number;
  retention: number;
  destinationId: string | null;
  last: { status: string; at: string | null; sizeBytes: string | null } | null;
  items: HubBackupItem[];
}

export interface ConfigChange {
  field: string;
  kind: "added" | "removed" | "changed";
  before?: string;
  after?: string;
}

export interface Deployment {
  id: string;
  status: DeploymentStatus;
  kind: string; // "DEPLOY" | "ROLLBACK" | "AUTO_ROLLBACK"
  logs: string | null;
  exitCode: number | null;
  imageTag: string | null;
  registryImage: string | null;
  imageDigest: string | null; // resolved upstream digest of the pulled image (nginx@sha256:…) — provenance
  rollbackable: boolean; // artifact retained → can be a rollback target (image tag/registry, or compose snapshot)
  durationMs?: number | null; // wall-clock ms (creation → terminal status); null for legacy/RUNNING rows
  trigger?: string | null; // origin: "manual" | "webhook" | "preview" | "rollback"; null for legacy rows
  commitSha?: string | null; // deployed git commit (GIT source); null otherwise
  commitMessage?: string | null; // first line of the deployed commit message (GIT source)
  configChanges?: ConfigChange[];
  createdAt: string;
}

export type DbEngine =
  | "POSTGRES"
  | "MYSQL"
  | "REDIS"
  | "MONGO"
  | "MARIADB"
  | "KEYDB"
  | "DRAGONFLY"
  | "CLICKHOUSE"
  | "LIBSQL";
export type DbStatus = "NEW" | "RUNNING" | "STOPPED" | "FAILED";

/** One app<->database link as returned by GET /apps/:id/database-links — never carries a secret. */
export interface DatabaseLinkView {
  linkId: string;
  envVar: string;
  restricted?: boolean;
  databaseId?: string;
  name?: string;
  engine?: DbEngine;
  serverId?: string;
  route?: "internal" | null;
  reason?: string;
  shadowedBy?: "app-env" | null;
  dbStatus?: DbStatus;
  createdAt?: string;
}

export interface Database {
  id: string;
  name: string;
  engine: DbEngine;
  version: string;
  environmentId: string;
  projectId: string | null;
  projectName: string | null;
  environmentName: string | null;
  serverId: string;
  teamId: string;
  status: DbStatus;
  port: number;
  hostPort: number | null;
  connectionUri: string | null;
  internalHost: string | null;
  publicHost: string | null;
  publicUri: string | null;
  username: string | null;
  password: string | null;
  database: string | null;
  healthCmd: string | null;
  memoryMb: number | null;
  cpus: number | null;
  backupEnabled: boolean;
  backupIntervalHours: number | null;
  backupRetention: number;
  backupDestinationId: string | null;
  backupSupported: boolean;
  tags: string[];
  role: Role;
  canWrite: boolean;
  createdAt: string;
}

/** Least-privilege API-token scopes. `admin` implies everything; `read` is implied by any grant. */
export type ApiTokenScope = "read" | "write" | "deploy" | "admin" | "read:secrets";

export interface ApiToken {
  id: string;
  name: string;
  prefix: string;
  scopes: ApiTokenScope[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface SavedView {
  id: string;
  name: string;
  status: ServerStatus | null;
  tags: string[];
  teamId: string | null;
  canDelete: boolean;
  createdAt: string;
}

export interface SharedVariable {
  id: string;
  teamId: string;
  key: string;
  value: string | null;
  canWrite: boolean;
  createdAt: string;
}

export type DestType = "LOCAL" | "S3";

export interface BackupDestination {
  id: string;
  name: string;
  type: DestType;
  teamId: string;
  s3Bucket: string | null;
  s3Region: string | null;
  s3Endpoint: string | null;
  s3Prefix: string | null;
  encryptionEnabled: boolean;
  hasCredentials: boolean;
  role: Role;
  canWrite: boolean;
  createdAt: string;
}

export type BackupStatus = "PENDING" | "RUNNING" | "SUCCESS" | "FAILED";

export interface Backup {
  id: string;
  status: BackupStatus;
  filename: string;
  sizeBytes: string | null;
  destinationType: string | null; // "S3" | "LOCAL" | null — only an S3 backup can export a migration URL
  createdBy: string;
  createdAt: string;
  completedAt: string | null;
}

export type RestoreKind = "RESTORE" | "RESTORE_TO" | "IMPORT_URL";
export type RestoreStatus = "RUNNING" | "SUCCESS" | "FAILED";
export interface Restore {
  id: string;
  kind: RestoreKind;
  status: RestoreStatus;
  exitCode: number | null;
  errorTail: string | null;
  backupId: string | null;
  createdAt: string;
  completedAt: string | null;
}
