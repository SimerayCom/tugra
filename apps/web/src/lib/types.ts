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
  iconUpdatedAt?: string | null;
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
  /** An outbound mailer (MAIL_HOST) is configured on the hub. `false` → reset/verification/invite email is
   *  never sent, so the UI must not imply it was. Optional: an older hub omits it (treated as unknown). */
  mailConfigured?: boolean;
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

/** A signed operator notice from the release manifest, surfaced to the instance owner. */
export interface InstanceUpdateNotice {
  id: string;
  message: string;
  severity: "info" | "warning" | "critical";
  url: string | null;
}

/** The member-level slice of the update status (GET /instance/version): any signed-in user. */
export interface InstanceVersionSummary {
  /** The running hub version. */
  current: string;
  /** The release channel being tracked ("stable" | "beta" | …). */
  channel: string;
  /** Latest published version for the tracked channel; null until the owner's hub has checked. */
  latest: string | null;
  /** Whether `latest` is strictly newer than `current`. */
  updateAvailable: boolean;
}

/** Self-update status (GET /instance/update, PATCH .../update, POST .../update/check). Owner-only. */
export interface InstanceUpdateStatus {
  /** The running hub version. */
  current: string;
  /** Latest published version for the tracked channel (from the last signed check); null until checked. */
  latest: string | null;
  /** The release channel being tracked ("stable" | "beta" | …). */
  channel: string;
  /** "auto" = no channel pinned, derived from the running build; "explicit" = the owner pinned one. */
  channelSource: "auto" | "explicit";
  /** Whether `latest` is strictly newer than `current` (never a downgrade). */
  updateAvailable: boolean;
  /** Link to the release notes, or null. */
  changelogUrl: string | null;
  /** Whether patch releases are applied automatically (the updater is not yet available). */
  autoUpdate: boolean;
  /** Signed remote operator notice for the tracked channel, or null. */
  notice: InstanceUpdateNotice | null;
  /** False when update checks are switched off (TUGRA_UPDATE_CHECKS=0) or the manifest is unconfigured. */
  checksEnabled: boolean;
  /** Minutes between background checks. */
  checkIntervalMin: number;
  /** ISO time of the last successful signed check; null = never. */
  lastCheckedAt: string | null;
  /** Short reason the most recent check attempt failed, else null. */
  lastCheckError: string | null;
  /** The update helper (tugra-updater sidecar) as the hub last saw it through the local agent. */
  updater: InstanceUpdaterStatus;
  /** A half-finished update the helper found (.env names a newer release than the one running); null when none. */
  halfUpdate: InstanceHalfUpdate | null;
}

/**
 * An earlier update stopped half-way (typically a full disk): the install's .env already names `envVersion` but the running
 * hub/web are still on `runningVersion`. "Finish update" resumes it; the helper puts .env back when the target cannot be pulled.
 */
export interface InstanceHalfUpdate {
  envVersion: string;
  runningVersion: string;
}

/**
 * The update helper's own release. `behind` = older than this hub (the hub then refreshes it itself after an update);
 * `state`: unknown (not probed / no sidecar) · current · behind · refreshing (just scheduled) · failed (did not converge).
 */
export interface InstanceUpdaterStatus {
  version: string | null;
  behind: boolean;
  state: "unknown" | "current" | "behind" | "refreshing" | "failed";
  checkedAt: string | null;
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

/** Owner mail settings (GET/PATCH /instance/mail). The SMTP password and Resend key are write-only — only
 *  `hasPassword` / `hasResendKey` reveal whether one is stored. `effective` is where the mailer actually reads
 *  its config: "db" (these settings), "env" (MAIL_* fallback) or "none" (mail not configured). */
export type MailProvider = "none" | "smtp" | "resend";
export interface MailSettings {
  provider: MailProvider;
  host: string | null;
  port: number | null;
  secure: boolean;
  user: string | null;
  from: string | null;
  hasPassword: boolean;
  hasResendKey: boolean;
  effective: "db" | "env" | "none";
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
  /** The team DNS credential this server's DNS-01 token was copied from (null/absent = none or typed by hand). */
  dnsCredentialId?: string | null;
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
  description: string | null;
  timezone: string | null;
  lastCleanupAt: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  seal: string | null;
  tags: string[];
  capabilities: string[]; // granted agent capabilities; [] = all
  isLocal: boolean; // the box the hub runs on (auto-provisioned on a turnkey single-box install)
  proxyBind: string; // how the reverse proxy publishes :80/:443 — "public" | "loopback" | "none"
  trafficAnalytics: boolean; // Traffic Analytics opt-in: the proxy writes a local JSON access log (default off)
  provider: string | null; // cloud provider that created this VM (null = manually enrolled)
  providerServerId: string | null; // provider-side id (present once created; enables destroy-VM)
  providerManualLink: boolean; // true = an operator linked an existing VM (out-of-band only; Tugra never destroys it)
  canWrite: boolean;
  canOps: boolean; // servers:ops — gates host operations such as GPU re-detection
}

// Out-of-band (cloud provider) access to a server: power, rescue and console without the agent.
export type OobPowerAction = "power_on" | "power_off" | "reboot" | "shutdown";
export interface OobProviderState {
  providerServerId: string;
  name: string;
  status: string; // provider power word: running | off | starting | stopping | rebuilding | migrating | initializing | ...
  locked: boolean;
  rescueEnabled: boolean;
  publicIpv4: string | null;
  publicIpv6: string | null;
}
export interface OobStatus {
  linked: boolean;
  provider: string | null;
  providerServerId: string | null;
  manual: boolean; // linked by hand (Tugra did not create the VM and never destroys it)
  supported: boolean;
  credentialName: string | null;
  credentialMissing: boolean;
  canManage: boolean;
  canOps: boolean;
  state: OobProviderState | null;
  stateError: string | null;
}
export interface OobActionResult {
  ok: true;
  action: string;
  providerAction: { id: string; status: "running" | "success" | "error"; command: string };
}
/** Returned once by the hub; the page keeps it in component state only. */
export interface OobRescueResult extends OobActionResult {
  rootPassword: string;
  expiresInMinutes: number;
}
/** Returned once by the hub; the page keeps it in component state only. */
export interface OobConsoleResult extends OobActionResult {
  wssUrl: string;
  password: string;
  validForSeconds: number;
}
export interface OobCandidate extends OobProviderState {
  matchesIp: boolean;
  taken: boolean;
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

// A team's external secret store (HashiCorp Vault). The access token is write-only — never returned by the API.
export interface SecretProvider {
  id: string;
  name: string;
  teamId: string;
  kind: string;
  address: string;
  lastVerifiedAt: string | null;
  refCount: number;
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

// The drain targets the agent can ship to: http = Tugra batch JSON, loki = Grafana Loki push, datadog = Datadog
// intake, and (D7) the non-HTTP transports syslog (RFC 5424), gelf (GELF 1.1) and fluentd (Forward protocol).
export type LogDrainType = "http" | "loki" | "datadog" | "syslog" | "gelf" | "fluentd";

/** Delivery state the hub derives for a drain (worst-of over the servers that ship it). */
export type DrainDelivery = "disabled" | "offline" | "agent_outdated" | "capability_revoked" | "pending" | "ok" | "error" | "invalid";

/** Closed set of failure classes an agent reports (no raw error text ever crosses the wire). */
export type DrainErrClass = "dns" | "dial" | "tls" | "timeout" | "refused" | "http" | "write" | "ack" | "policy" | "config" | "overflow";

export interface LogDrain {
  id: string;
  name: string;
  type: string;
  endpoint: string;
  enabled: boolean;
  hasToken: boolean;
  createdAt: string;
  // D7 (per-app drains): scope + container filter + per-transport options + egress flag + delivery.
  scope: "server" | "app";
  appId: string | null;
  containers: string[];
  options: Record<string, unknown> | null;
  allowPrivate: boolean;
  delivery: DrainDelivery;
  status: { sent: number; dropped: number; truncated?: number; errClass?: DrainErrClass; lastOkAt?: string } | null;
}

/** One app drain shipping logs off a server, as the SERVER operator sees it (no endpoint/options/token). */
export interface AppDrainSummary {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  appId: string;
  appName: string;
  delivery: DrainDelivery;
}

/** Create/update body of a log drain (server or app route). `options` carry NO secrets: the token field holds
 *  the http/loki/datadog bearer or the fluentd shared key. */
export interface LogDrainInput {
  name?: string;
  type?: LogDrainType;
  endpoint?: string;
  token?: string | null;
  enabled?: boolean;
  containers?: string[];
  options?: Record<string, unknown> | null;
  allowPrivate?: boolean;
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
  /** Packages a normal update installs — excludes `phased`. */
  packages: UpgradablePackage[];
  /** `packages.length`: phased packages are not counted. */
  count: number;
  /** apt only: upgradable packages Ubuntu is still rolling out gradually; a normal update defers them until this
   *  server's turn. Absent from a hub older than this field (treat as none). */
  phased?: UpgradablePackage[];
  /** apt only: packages a cut-off earlier run left half-configured; null when dpkg is clean. A check only REPORTS it —
   *  an update (which runs on the host and may restart the container engine) is what finishes it. */
  dpkgInterrupted: DpkgInterrupted | null;
  /** An update started earlier is still running on the host — this list is mid-flight, not final. */
  applyRunning: boolean;
}

export interface InterruptedPackage {
  name: string;
  state: "half-configured" | "unpacked" | "half-installed" | "triggers-pending";
}
export interface DpkgInterrupted {
  packages: InterruptedPackage[];
  /** Includes the container engine: finishing it restarts Docker, and with it every container. */
  containerEngine: boolean;
}

// Reboot server: a requested reboot, scheduled or in progress, and the verification report once the server is back.
export type RebootState = "SCHEDULED" | "STARTING" | "REBOOTING" | "WAITING_AGENT" | "VERIFYING" | "DONE";
export type RebootResult = "ok" | "degraded" | "failed" | "cancelled";
export type RebootContainerVerdict = "ok" | "missing" | "unhealthy" | "pending" | "skipped";
export type RebootDomainVerdict = "ok" | "not_answering" | "not_answering_before" | "pending" | "unverified";
export interface RebootReport {
  version: 1;
  checkedAt: string;
  rebooted: boolean;
  docker: "active" | "inactive" | "unknown";
  containers: { name: string; image: string; restartPolicy: string; hadHealthcheck: boolean; verdict: RebootContainerVerdict; detail?: string }[];
  domains: { host: string; verdict: RebootDomainVerdict; status: number | null }[];
  domainsNote?: "skipped_no_host_port" | "probe_unavailable";
  rebootRequired: "cleared" | "still_set" | "unknown";
  /** A closed failure code (rendered through reboot.reason.*), never raw output. */
  reason?: string;
  summary: { containersOk: number; containersExpected: number; domainsOk: number; domainsExpected: number };
}
export interface RebootView {
  id: string;
  serverId: string;
  mode: "now" | "scheduled";
  state: RebootState;
  result: RebootResult | null;
  requestedBy: string;
  scheduledAt: string | null;
  startedAt: string | null;
  agentBackAt: string | null;
  verifiedAt: string | null;
  createdAt: string;
  snapshot: { containers: number; domains: number; hostsHub: boolean } | null;
  report: RebootReport | null;
}
export interface RebootStatus {
  active: RebootView | null;
  last: RebootView | null;
}
export interface RebootPreview {
  containers: number;
  domains: number;
  hostsHub: boolean;
  agentOnline: boolean;
}
export type RebootRequest = { mode: "now"; confirmName: string } | { mode: "scheduled"; at: string; confirmName: string };

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
  load1?: number;
  load5?: number;
  load15?: number;
  swapUsed?: number;
  swapTotal?: number;
  temp?: number;
  sensors?: Record<string, number>;
  gpus?: GpuStat[];
  battery?: BatterySample | null;
  /** Per-minute PEAK cpu % — only on rollup-backed (7d/30d) history reads, where `cpu` is the bucket average. */
  cpuMax?: number;
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

export type MetricsRange = "1h" | "6h" | "24h" | "7d" | "30d";

/** One row of GET /fleet/metrics/trend: a server's recent per-minute CPU / memory % (sparkline source). */
export interface FleetTrendRow {
  serverId: string;
  points: { ts: number; cpu: number; mem: number | null }[];
}

/** One row of GET /fleet/metrics/latest: a server's newest sample, for the fleet overview table. */
export interface FleetLatestRow {
  serverId: string;
  sample: MetricsSample;
}

/** One row of GET /fleet/containers/hottest: a live container on a visible server, ranked by CPU. */
export interface HottestContainerRow {
  serverId: string;
  serverName: string;
  containerName: string;
  label: string; // friendly name ("WordPress · db", "hub-api") — show this, not the raw tugra_ name
  kind: "app" | "db" | "system" | "other";
  resourceId?: string;
  service?: string;
  cpu: number;
  memUsed: number;
  memTotal: number;
  memPct: number;
  netRx: number;
  netTx: number;
  blkRead: number;
  blkWrite: number;
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
  /** Per-minute PEAK cpu % — only on rollup-backed (7d/30d) reads. */
  cpuMax?: number;
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
  // Last-known crash/health state (from the container-health poll), joined server-side for badges.
  // Optional: absent when the poll hasn't recorded this container yet, so a row with none shows no badge.
  restartCount?: number;
  exitCode?: number;
  oomKilled?: boolean;
  health?: string | null;
  finishedAt?: string | null;
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
  // Last-known crash/health state (from the container-health poll), joined server-side so a stopped
  // container can be badged "Exit 137" / "OOM" / restart count. Optional — absent when not yet recorded.
  restartCount?: number;
  exitCode?: number;
  oomKilled?: boolean;
  health?: string | null;
  finishedAt?: string | null;
}
export interface HostContainers {
  containers: HostContainer[];
}

// Read-only runtime view of an app's containers + recent crash/OOM episodes, surfaced from the
// container-health poll (ContainerState / ContainerEvent). Dates are ISO strings. The raw log tail is
// gated server-side: `logTail` is null + `logRedacted` true for callers without read:secrets + apps:config.
export interface ContainerRuntimeState {
  containerName: string;
  status: string;
  exitCode: number;
  oomKilled: boolean;
  restartCount: number;
  health: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}
export interface ContainerCrashEvent {
  id: string;
  containerName: string;
  ts: string;
  kind: string; // "crash" | "oom"
  exitCode: number;
  oomKilled: boolean;
  restartCount: number;
  restartDelta: number;
  reason: string | null;
  logTail: string | null;
  logRedacted: boolean;
}
export interface AppRuntimeState {
  containers: ContainerRuntimeState[];
  events: ContainerCrashEvent[];
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
  /** Provider kind: a GitHub App or a token provider of the Gitea family. */
  kind: GitSourceKind;
  /** GitHub App id (github only; null for a token source). */
  appId: string | null;
  appSlug: string | null;
  installationId: string | null;
  htmlUrl: string | null;
  /** Token providers: the instance base URL. */
  apiUrl: string | null;
  /** A credential is stored. The credential itself is write-only and never returned. */
  hasToken: boolean;
  /** The only repository host this source's credential authenticates (github.com for a GitHub App, the instance host otherwise). */
  cloneHost: string;
  createdAt: string;
  canWrite: boolean;
}

export type GitSourceKind = "github" | "gitea" | "forgejo" | "codeberg";

export interface SourceRepo {
  fullName: string;
  cloneUrl: string;
  private: boolean;
  defaultBranch: string | null;
}

export interface SourceBranch {
  name: string;
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
  kind: "app" | "database" | "volume" | "service";
  name: string;
  proposed: Record<string, unknown>;
  risks: ImportRisk[];
  dependsOn: string[];
}
export type DbDataPlane = "one-click" | "manual" | "blocked" | "volume";
/** How a Coolify service stack imports: ready, imported without some members / data, or not imported at all. */
export type ImportServiceVerdict = "importable" | "partial" | "skipped";
/** Per-service operator choices, keyed by plan itemRef (mirrors the hub's ServiceChoice). They can only narrow or rename. */
export interface ImportServiceChoice {
  skip?: boolean;
  name?: string;
  environmentId?: string;
  targetServerId?: string;
  serviceDomains?: Array<{ service: string; hostname: string; port: number }>;
  hostnameMap?: Record<string, string>;
  volumes?: Record<string, { policy: "copy" | "empty" | "skip"; owner?: { uid: number; gid: number } }>;
  dropMembers?: string[];
  pinImages?: boolean;
  pins?: Record<string, string>;
  privateNetwork?: boolean;
  hold?: boolean;
}
/** One service's review card (variable NAMES, compose keys, volume keys, hostnames and fixed reasons only: never a value). */
export interface ImportServicePreview {
  itemRef: string;
  name: string;
  sourceServer?: string;
  verdict: ImportServiceVerdict;
  compat: "template" | "passthrough" | "blocked";
  members: Array<{ name: string; status: "kept" | "dropped"; reason?: string }>;
  env: { resolved: string[]; missing: string[]; secretsAvailable: boolean };
  domains: Array<{ service: string; hostname: string; port: number }>;
  domainHints: Array<{ service: string; port: number }>;
  volumes: Array<{ key: string; origin: "named" | "host-bind"; policy: "copy" | "empty" | "skip"; dataPlane: string; mounts: Array<{ service: string; path: string }> }>;
  files: { needed: string[]; available: string[] };
  notCarried: ImportCoverageEntry[];
  blockers: Array<{ code: string; message: string }>;
  floating: string[];
  pinned: string[];
  hold: boolean;
}
/** A post-import checklist row: i18n kind + short params only (no source free text). */
export interface ImportChecklistItem {
  kind: "deploy-after-data" | "data-step" | "quiesce" | "dns" | "tunnel" | "repoint-dependents" | "unpinned-image" | "not-carried" | "reach";
  severity: "info" | "warn";
  params: Record<string, string | number | string[]>;
}
/** An applied service task's secret-free summary. */
export interface ImportServiceTaskView {
  members: string[];
  dropped: Array<{ field: string; reason: string }>;
  configMounts: number;
  serviceDomains: { applied: number; unmapped: Array<{ field: string; reason: string }> };
  privateNetwork?: { network: string; alias: string };
  volumes: Array<{ key: string; dockerName: string; policy: string; dataPlane: string; state: string }>;
  hold: boolean;
  checklist: ImportChecklistItem[];
  steps: Array<{ name: string; status: string }>;
}
/** The remote PaaS sources the wizard can connect to (local-docker adoption has its own UI on a server's page). */
export type ImportRemoteKind = "coolify" | "dokploy";
/** One field present on the source that Tugra does not carry: a field NAME + a fixed reason, never a value. */
export interface ImportCoverageEntry {
  field: string;
  /** English fallback; the UI translates `reasonCode` (+ `reasonParams`) and only shows this for an unknown code. */
  reason: string;
  reasonCode?: string;
  reasonParams?: Record<string, string | number>;
  level: "warn" | "info";
}
export interface ImportCoverageApp {
  itemRef: string;
  name: string;
  notCarried: ImportCoverageEntry[];
}
export type ImportEnvReason = "NO_VALUE" | "SHARED_UNEXPANDED" | "MAGIC" | "LOCKED";
/** Strict-env summary (Coolify): variable NAMES + reason codes only, never values. */
export interface ImportCoverageEnvApp {
  itemRef: string;
  name: string;
  unresolved: Array<{ key: string; reason: ImportEnvReason }>;
  invalidKeys: string[];
  previewSkipped: number;
  tokenReadOnly: boolean;
}
export interface ImportCoverage {
  apps: ImportCoverageApp[];
  env?: { apps: ImportCoverageEnvApp[] };
  git?: { apps: number; https: number; ssh: number; githubApp: number };
}
/** An operator acknowledgement of an ackable plan blocker ("create the app WITHOUT these variables"). */
export interface ImportAck {
  code: "app.env.unresolved" | "app.env.key.invalid";
  itemRef?: string;
}

/** The plan-step choices an apply must carry whichever screen sends it (one-click or "Review & rename"): env acks,
 *  per-service choices and the physical-copy data modes. Computed once in the plan view; each part only when set. */
export interface ImportApplyExtras {
  acks?: ImportAck[];
  serviceChoices?: Record<string, ImportServiceChoice>;
  dbDataModes?: Record<string, "volume">;
}
export interface ImportPreflight {
  databases: Array<{ name: string; engine: string; dataPlane: DbDataPlane; reason: string; backup?: { schedules?: number; s3?: boolean; interval?: string; targets?: string[] } }>;
  services: Array<{ name: string; members: number; note: string; objectStore?: true; verdict?: ImportServiceVerdict; hold?: boolean; volumes?: Array<{ key: string; dataPlane: string; origin?: "host-bind" }> }>;
  appsWithVolumeData: number;
  volumeDataNote?: string;
  volumes?: Array<{ app: string; mountPath: string; type?: "named" | "bind"; dataPlane: "hub-staged" | "manual-large" | "manual" | "unknown-size" | "stream"; reason: string; fidelity?: string }>;
  /** Per-app "what is not carried over" (advisory; presence-only). */
  coverage?: ImportCoverage;
  /** Coolify: apps whose variables are unreadable because the API token lacks read:sensitive. */
  env?: { tokenReadOnlyApps: number };
  /** Git hosts the apps clone from (host + app count). */
  git?: { hosts: Array<{ host: string; apps: number }> };
  /** The source servers by name (Coolify, Dokploy), so a host is shown by its name and not by its uuid. */
  hosts?: Array<{ ref: string; name?: string; controlPlane?: true; unreachableCount?: number; os?: string }>;
  /** Apps already failing at the source (exited, unhealthy, crash-looping): they migrate as they are. */
  sourceHealth?: Array<{ itemRef: string; name: string; health: "unhealthy" | "unknown" | "exited"; status?: string; restartCount: number | null }>;
}
export interface ImportPlan {
  sourceKind: string;
  mode: "copy" | "takeover";
  items: ImportPlanItem[];
  totals: { apps: number; databases: number; volumes: number; blockers: number; services?: number };
  warnings: string[];
  planHash: string;
  preflight?: ImportPreflight;
  /** Additive, outside planHash. Absent on a hub that predates editable mappings (the review step is then hidden). */
  mapping?: { features: string[]; stored: ImportMappingDoc | null; storedVersion: number | null; scopeKey: string };
}

// ── editable import mapping (names + placement only — never a secret) ──
export interface ImportMappingItem {
  include?: boolean;
  name?: string;
  project?: string;
  environment?: string;
  containerAlias?: string | null;
  dbIdentifier?: string;
}
export interface ImportMappingDoc {
  version: 1;
  scope?: { sourceKind: ImportRemoteKind; scopeKey?: string };
  items: Record<string, ImportMappingItem>;
  projects: Record<string, { name?: string; environments?: Record<string, string> }>;
  gitSources: Record<string, { name: string }>;
  acks: string[];
}
export type ImportConflictLevel = "error" | "warn" | "info";
export interface ImportConflict {
  code: string;
  level: ImportConflictLevel;
  itemRef?: string;
  ref?: string;
  field?: "name" | "project" | "environment" | "containerAlias" | "dbIdentifier";
  params: Record<string, string | number>;
  requiresAck?: boolean;
  ackKey?: string;
  acked?: boolean;
}
export interface ImportEffectiveItem {
  itemRef: string;
  kind: "app" | "database";
  sourceName: string;
  include: boolean;
  name: string;
  project: string | null;
  environment: string | null;
  containerAlias?: string | null;
  dbIdentifier?: string;
  origin: { name: "source" | "mapping"; placement: "mapping" | "tree" | "default" | "selected"; alias?: "mapping"; dbIdentifier?: "mapping" | "derived" };
  status: "pending" | "blocked" | "already_imported" | "excluded";
  existing?: { resourceType: string; resourceId: string; name: string };
  changed: Array<"name" | "project" | "environment" | "containerAlias" | "include">;
  drift?: Array<"name" | "environment" | "containerAlias">;
}
export interface ImportResolved {
  version: 1;
  effective: ImportEffectiveItem[];
  projects: Array<{ name: string; environments: string[]; willCreate: boolean; envsToCreate: string[]; itemCount: number }>;
  gitSources: Array<{ ref: string; sourceName: string; name: string; exists: boolean }>;
  conflicts: ImportConflict[];
  orphans: string[];
  mappingHash: string;
  counts: { renamed: number; moved: number; excluded: number; aliased: number; newProjects: number; newEnvironments: number };
}
export interface ImportStoredMapping {
  doc: ImportMappingDoc | null;
  version: number | null;
  label: string | null;
  lastAppliedAt: string | null;
}
/** The short-lived encrypted connection returned by import_connect. */
/** `GET /import/egress-ip`: the address the source sees this hub connect from. `ip: null` = the hub cannot tell (never guessed). */
export interface ImportEgressIp {
  ip: string | null;
  source: "env" | "server" | "unknown";
}

export interface ImportSession {
  sessionId: string;
  expiresAt: string;
}
export type ImportTaskStatus =
  | "PENDING" | "RUNNING" | "DONE" | "FAILED" | "SKIPPED" | "ROLLED_BACK" | "FAILED_VERIFY" | "AWAITING_CUTOVER" | "CANCELLED";
/** What an applied app could (applied) and could not (unmapped) carry — field names + fixed reasons only. */
export interface ImportApplyReport {
  applied: string[];
  unmapped: ImportUnmapped[];
}
/** One field an apply could not carry: a field NAME + a fixed reason (code + params for the UI), never a value. */
export interface ImportUnmapped {
  field: string;
  reason: string;
  reasonCode?: string;
  reasonParams?: Record<string, string | number>;
}
export type ImportGitStatus = "linked" | "public_ok" | "needs_source" | "ambiguous" | "ssh_deploy_key" | "unsupported_host" | "unknown";
/** One git app's link resolution (before apply: `POST /import/git-links`). Names + fixed text only, never a credential. */
export interface ImportGitLinkRow {
  itemRef: string;
  name: string;
  repo: { host: string; owner: string; name: string } | null;
  status: ImportGitStatus;
  sourceId?: string;
  sourceName?: string;
  candidates?: { id: string; name: string }[];
  rewriteUrl?: string;
  reason: string;
}
export interface ImportGitLinksView {
  rows: ImportGitLinkRow[];
  groups: Array<{ host: string; owner: string; apps: number; status: ImportGitStatus; sourceName?: string }>;
}
export type ImportRelinkOutcome = "linked" | "already_linked" | "not_linked" | "invalid_choice" | "failed";
export interface ImportRelinkResult {
  itemRef: string;
  name: string;
  outcome: ImportRelinkOutcome;
  status: ImportGitStatus;
  sourceName?: string;
  candidates?: { id: string; name: string }[];
}
export interface ImportTaskGit {
  status: ImportGitStatus;
  sourceName?: string;
  rewritten?: boolean;
  deployKeyPublic?: string;
}
export interface ImportOpTask {
  itemRef: string | null;
  kind: string;
  name: string | null;
  /** Under an editable mapping: the source-side name, and a marker. Absent without one. */
  sourceName?: string;
  mapped?: boolean;
  status: ImportTaskStatus;
  resourceType: string | null;
  resourceId: string | null;
  message: string | null;
  unresolvedEnv?: number;
  /** Strict env: the NAMES of the variables the app was created without (acknowledged). */
  unresolvedKeys?: string[];
  droppedInvalidKeys?: string[];
  /** Git link outcome (git apps): status, source name and the PUBLIC deploy key. */
  git?: ImportTaskGit;
  postCreate?: ImportApplyReport;
  ingress?: ImportApplyReport;
  /** Set for an applied Coolify service: its members, volumes and the post-import checklist. */
  service?: ImportServiceTaskView;
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
  /** Streamed volume copy: dry-run / run / resume with a <TOKEN> placeholder (absent when the stream is off). */
  commandsTemplate?: VxCommands;
}
/** The three commands of the streamed volume copy (the "Move data" step). */
export interface VxCommands {
  dryRun: string;
  run: string;
  resume: string;
}
/** The minted token response — the full `command` is shown ONCE (the token is hashed at rest). */
export interface MintedMigrationToken {
  opId: string;
  token: string;
  expiresAt: string;
  command: string; // ready-to-paste one-liner carrying the live token
  /** Streamed volume copy commands carrying the same live token (absent when the stream is off). */
  commands?: VxCommands;
}

// ── post-import: streamed volume data (the migrator streams a stopped source in resumable parts) ──
export type VxGateStatus = "pass" | "fail" | "unknown";
export interface VxGate {
  id: "inventory" | "credentials" | "major" | "layout" | "image" | "state" | "quiesced";
  status: VxGateStatus;
  text: string;
}
export type VolumeTransferState = "NONE" | "EXCLUDED" | "PENDING" | "COPYING" | "COPIED" | "APPLYING" | "DONE" | "FAILED" | "ABORTED";
/** The facts the migrator reported about one source volume (untrusted: the UI labels them as reported by it). */
export interface VxInventoryView {
  found: boolean;
  rawBytes: number;
  entries: number;
  mountType: "volume" | "bind";
  running: boolean;
  exitCode?: number;
  image?: string;
  pgMajor?: string;
  pgLayout?: "root" | "nested" | "none";
  mountDest?: string;
  specials: { sockets: number; fifos: number; devices: number };
}
export interface VxDiskVerdict {
  ok: boolean;
  unknown: boolean;
  details: Record<string, number | boolean | string | null>;
}
export interface VolumeTransferView {
  itemRef: string;
  resourceName: string | null;
  mountPath: string;
  destType: "app-volume" | "db-data";
  destVolume: string;
  state: VolumeTransferState;
  phase: "verifying" | "skipping" | "streaming" | "applying" | "provisioning" | string | null;
  partsDone: number;
  bytesDone: number;
  rawBytesDone: number;
  rawBytesTotal: number | null;
  bps: number | null;
  etaSec: number | null;
  inventory: VxInventoryView | null;
  diskVerdict: VxDiskVerdict | null;
  gates: VxGate[] | null;
  evidenceNote: "reported by the migrator";
  excluded: { reason: string } | null;
  error: string | null;
  steps: Array<{ name: string; status: string }>;
  canAbort: boolean;
  canReset: boolean;
}
export interface OpVolumes {
  volumes: VolumeTransferView[];
  tokenExpiresAt: string | null;
  enabled: boolean;
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
export type SourceCommitMode = "OFF" | "RUNTIME" | "BUILD";
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
  timeoutSec: number | null;
  lastRunAt: string | null;
}

export interface ScheduledTaskRun {
  id: string;
  status: string; // RUNNING | SUCCESS | FAILED
  trigger: string; // schedule | manual
  exitCode: number | null;
  output: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
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

export type AppLinkKind = "primary" | "alias" | "service" | "port";

/** One externally-openable address of an app (always http or https). */
export interface AppLink {
  kind: AppLinkKind;
  url: string;
  /** Hostname of a domain-backed link; null for a raw IP:port. */
  host: string | null;
  /** The compose service (`service`) or `service:containerPort` (`port`); null otherwise. */
  label: string | null;
}

export interface Project {
  id: string;
  teamId: string;
  name: string;
  isDefault: boolean;
  environments: Environment[];
  role: Role;
  canWrite: boolean;
  iconUpdatedAt: string | null;
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
    state: "ok" | "expiring" | "error" | "none";
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

export interface AppContainerHealth {
  state: "healthy" | "unhealthy" | "starting" | "none" | "unknown";
  checkType: "CMD" | "HTTP" | "NONE";
  containers: number;
  observedAt: string | null;
}

export type PrProvider = "github" | "gitlab" | "gitea" | "forgejo" | "bitbucket" | "bitbucket-server";
/** Per-app "image update available" verdict (IMAGE apps; null for every other app). Digests are writer-only. */
export type ImageUpdateState = "disabled" | "pinned" | "unsupported" | "no_baseline" | "pending" | "up_to_date" | "update_available" | "error";
export type ImageUpdateError = "auth" | "notfound" | "unsupported" | "timeout" | "failed";
export interface ImageUpdate {
  enabled: boolean;
  state: ImageUpdateState;
  updateAvailable: boolean;
  checkedAt: string | null;
  changedAt: string | null; // when the current upstream digest was first seen
  error: ImageUpdateError | null; // only when state === "error"
  upstreamDigest: string | null; // writer-only
  deployedDigest: string | null; // writer-only
}

export interface Application {
  id: string;
  name: string;
  description: string | null;
  templateSlug: string | null;
  templateLogo: string | null;
  // ISO timestamp when a custom icon was last uploaded (null = no custom icon); cache-busts the icon URL.
  iconUpdatedAt: string | null;
  source: AppSource;
  image: string | null;
  gitUrl: string | null;
  gitBranch: string | null;
  gitCommit: string | null; // pinned commit SHA; null = deploy the branch HEAD
  gitSubmodules: boolean;
  gitLfs: boolean;
  gitShallowClone: boolean;
  disableBuildCache: boolean;
  injectEnvAsBuildArgs: boolean;
  sourceCommitMode: SourceCommitMode;
  gitSourceId: string | null;
  buildType: BuildType;
  buildCommand: string | null;
  nixpacksInstallCmd: string | null;
  nixpacksBuildCmd: string | null;
  nixpacksStartCmd: string | null;
  dockerfilePath: string | null;
  dockerBuildTarget: string | null;
  inlineDockerfile: string | null; // DOCKERFILE build: inline Dockerfile text (writer-only; null for read-only members)
  hasInlineDockerfile: boolean; // an inline Dockerfile overrides the repository's (visible to everyone)
  baseDirectory: string | null;
  watchPaths: string[];
  autoDeploy: boolean;
  imageUpdate?: ImageUpdate | null; // optional so older fixtures/clients still type-check; the hub always sends it
  /** The app's live (non-terminal) move, null when none. Drives the lock on edit/lifecycle controls. */
  move?: { id: string; phase: AppMovePhase } | null;
  previewExcludeKeys: string[];
  previewLimit: number | null;
  extraPorts: { hostPort: number; containerPort: number; protocol: "tcp" | "udp" }[];
  networkAliases: string[];
  stopGracePeriodSec: number | null; // graceful-stop window; null = Docker's default (10s)
  drainSec: number | null; // rolling deploys: seconds both versions serve before the old one stops
  restartMaxRetries: number | null; // on-failure retry cap
  containerAlias: string | null; // stable DNS name on every network the app joins
  networks: string[]; // extra user Docker networks
  networkingLocked: boolean; // a raw --network in Docker options owns networking; the alias/networks inputs are disabled
  // Where other containers reach this app; null when unknown (compose / swarm / custom --network in Docker options).
  internalHost: { host: string; port: number; networks: string[]; aliases: string[] } | null;
  outputDir: string | null;
  composeFile: string | null;
  composePath: string | null;
  healthCmd: string | null;
  healthCheckType: string | null;
  healthCheckPath: string | null;
  healthCheckPort: number | null;
  healthCheckMethod: string | null;
  healthCheckScheme: string | null;
  healthCheckResponseText: string | null;
  healthInterval: number | null;
  healthTimeout: number | null;
  healthRetries: number | null;
  healthStartPeriod: number | null;
  healthExpectedStatus: number | null;
  memoryMb: number | null;
  cpus: number | null;
  reserveMemoryMb: number | null;
  reserveCpus: number | null;
  memorySwapMb: number | null;
  pidsLimit: number | null;
  shmSizeMb: number | null;
  cpuShares: number | null;
  cpusetCpus: string | null;
  gpus: string | null;
  deployTimeoutSec: number | null;
  dockerOptions: string | null;
  /** Instance-owner opted this app into privileged docker options (--privileged, host devices, docker.sock…). Default false. */
  allowPrivilegedDockerOptions: boolean;
  // Pre/post-deploy hook commands (writer-only in the API → null for read-only members). Single-server apps.
  preDeployCommand: string | null;
  postDeployCommand: string | null;
  // COMPOSE hooks: the service they run in (writer-only) + the pasted-compose service names for the picker ([] for git-compose).
  composeHookService: string | null;
  composeServices: string[];
  // Container ENTRYPOINT/CMD override, exec-form argv (writer-only; null for read-only members). null = image
  // default; containerEntrypoint [] clears the image entrypoint.
  containerEntrypoint: string[] | null;
  containerCommand: string[] | null;
  // Operator custom container labels {key: value} (writer-only; null for read-only members and when none are set).
  customLabels: Record<string, string> | null;
  restartPolicy: string | null; // Docker restart policy; null = the "unless-stopped" default
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
  pushImageName: string | null; // custom pushed repo path (null = tugra_<id>)
  pushImageTag: string | null; // mutable alias tag template, {sha}/{branch} (null = no alias)
  buildServerId: string | null;
  clusterId: string | null;
  replicas: number | null;
  placement: Placement;
  constraintServerId: string | null;
  deployStrategy: string;
  rollbackOnFailure: boolean;
  imagesToKeep: number | null;
  postCutoverSoakSec: number;
  zeroDowntime: boolean;
  environmentId: string;
  projectId: string | null;
  projectName: string | null;
  environmentName: string | null;
  serverId: string;
  teamId: string;
  status: AppStatus;
  /** Aggregated Docker container health from the hub's poll. `unknown` = no fresh data. */
  containerHealth: AppContainerHealth;
  hostPort: number | null;
  containerPort: number | null;
  domain: string | null;
  extraDomains: string[];
  /** Every openable address, primary first (aliases, per-service domains, published compose ports follow). */
  links: AppLink[];
  domainRedirect: "www" | "root" | null;
  securityHeaders: boolean;
  gzip: boolean;
  /** Custom-domain certificate issued with DNS-01 per host (needs DNS-01 credentials on the server). */
  dnsChallenge: boolean;
  forwardAuth: string | null;
  ipAllowlist: string[];
  basicAuthUsers: string[]; // usernames only (password hashes never returned)
  pathPrefix: string | null;
  stripPrefix: boolean;
  rateLimit: { average: number; burst: number; period: "1s" | "1m" | "1h" } | null;
  redirects: { regex: string; replacement: string; permanent: boolean }[];
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
  /** Which git host's event created this preview (null = legacy / GitHub-era row). */
  prProvider: PrProvider | null;
  /** The head commit the preview last built (lowercase hex), for display only. */
  prHeadSha: string | null;
  parentAppId: string | null;
  tags: string[];
  volumeBackupEnabled: boolean;
  volumeBackupIntervalHours: number | null;
  volumeBackupRetention: number;
  volumeBackupDestinationId: string | null;
  envCount: number;
  canWrite: boolean;
  canDeploy: boolean; // apps:deploy — gates Check now / Pull & redeploy (the API enforces the same right)
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
  exitCode: number | null;
  durationMs: number | null; // run start → completedAt
  errorTail: string | null; // scrubbed failure output; null for read-only members (writer-only server-side)
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
  cron: string | null;
  retention: number;
  retentionDays: number | null;
  maxSizeGb: number | null;
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
  /** Full build/deploy log. null for a RUNNING row and for a `slim` list row (use hasLogs + the detail endpoint). */
  logs: string | null;
  exitCode: number | null;
  imageTag: string | null;
  registryImage: string | null;
  imageDigest: string | null; // resolved upstream digest of the pulled image (nginx@sha256:…) — provenance
  rollbackable: boolean; // artifact retained → can be a rollback target (image tag/registry, or compose snapshot)
  /** Ran on the app's PREVIOUS server (an app move) and only has a local tag there: it can no longer be rolled back to. */
  rollbackPredatesMove?: boolean;
  runServerId?: string | null; // server the deploy ran on; null = the app's current server
  durationMs?: number | null; // wall-clock ms (start → terminal status); null for legacy/RUNNING rows
  trigger?: string | null; // origin: "manual" | "webhook" | "preview" | "rollback" | "rollout"; null for legacy rows
  commitSha?: string | null; // deployed git commit (GIT source); null otherwise
  commitMessage?: string | null; // first line of the deployed commit message (GIT source)
  configChanges?: ConfigChange[];
  createdAt: string;
  startedAt?: string | null; // QUEUED → RUNNING moment; null while queued
  noCache?: boolean;
  /** Rollout state the deploy script reported (healthy | converged | rolled_back | rollback_failed | failed), hub-parsed. */
  rollout?: string | null;
  /** The row has a persisted log (a slim list row carries logs: null even when true). */
  hasLogs?: boolean;
}

export type DeploymentNote = "interrupted" | "recovering" | "auto_rollback" | "cancelled";
export type DeploymentActorKind = "user" | "webhook" | "preview" | "rollout" | "system" | "unknown";

/** GET /apps/:id/deployments/:depId — one deployment with the derived facts the detail page shows. */
export interface DeploymentDetail extends Deployment {
  appId: string;
  diffBase: { id: string; createdAt: string } | null;
  isCurrent: boolean;
  cancellable: boolean;
  finishedAt: string | null;
  actor: { kind: DeploymentActorKind; name: string | null };
  note: DeploymentNote | null;
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

/** One app secret-ref as returned by GET /apps/:id/secret-refs — the locator only, never a secret value. */
export interface SecretRefView {
  refId: string;
  envVar: string;
  providerId: string;
  providerName: string;
  kind: string;
  remoteKey: string;
  overridesAppEnv: boolean;
  createdAt: string;
}

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
  backupCron: string | null;
  backupRetention: number;
  backupRetentionDays: number | null;
  backupMaxSizeGb: number | null;
  backupDestinationId: string | null;
  backupSupported: boolean;
  verifyEnabled: boolean;
  verifyIntervalHours: number | null;
  verifyCron: string | null;
  lastVerifiedAt: string | null;
  pitrEnabled: boolean;
  pitrEnabledAt: string | null;
  baseBackupEnabled: boolean;
  baseBackupIntervalHours: number | null;
  baseBackupCron: string | null;
  tags: string[];
  volumes: { name: string; path: string }[];
  dataLayoutWarning?: "pg_anonymous_volume" | null;
  role: Role;
  canWrite: boolean;
  iconUpdatedAt: string | null;
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

/** POST /backup-destinations only: the one-time plaintext data key (null when created unencrypted). */
export type CreatedDestination = BackupDestination & { recoveryKey: string | null };

export interface DestinationTestResult {
  ok: boolean;
  message: string;
  encryption?: "OK" | "FAILED" | "SKIPPED";
}

export interface VolumeBackupPolicy {
  volumeName: string;
  enabled: boolean;
  intervalHours: number | null;
  cron: string | null;
  retention: number | null;
  retentionDays: number | null;
  maxSizeGb: number | null;
}

export interface BackupUsage {
  pool: string;
  /** null/absent = the shared app pool; else the volume that owns this pool (a volume may itself be named "app"). */
  volume?: string | null;
  usedBytes: string;
  backupCount: number;
  unknownSizeCount: number;
  budgetGb: number | null;
  overBudget: boolean;
}

/** GET /apps/:id/volume-backups/config — app-wide volume-backup schedule/retention + per-volume policies + usage. */
export interface VolumeBackupConfig {
  enabled: boolean;
  intervalHours: number | null;
  cron: string | null;
  retention: number;
  retentionDays: number | null;
  maxSizeGb: number | null;
  destinationId: string | null;
  destinationEncrypted: boolean | null;
  policies: VolumeBackupPolicy[];
  usage: BackupUsage[];
  nextRun: string | null;
}

export interface SchedulePreview {
  valid: boolean;
  error?: string;
  timezone: string;
  nextRuns: string[];
  minGapSeconds: number | null;
}

export interface SealedKeyExport {
  filename: string;
  format: string;
  contentBase64: string;
  destinationCount: number;
  undecryptable: string[];
}

export type BackupStatus = "PENDING" | "RUNNING" | "SUCCESS" | "FAILED";

export interface Backup {
  id: string;
  status: BackupStatus;
  filename: string;
  sizeBytes: string | null;
  destinationId: string | null; // which destination stored it (null = local disk)
  destinationType: string | null; // "S3" | "LOCAL" | null — only an S3 backup can export a migration URL
  createdBy: string;
  createdAt: string;
  completedAt: string | null;
  exitCode: number | null;
  durationMs: number | null; // run start → completedAt
  errorTail: string | null; // scrubbed failure output; null for read-only members (writer-only server-side)
}

export type RestoreKind = "RESTORE" | "RESTORE_TO" | "IMPORT_URL" | "VERIFY" | "PITR";
export type RestoreStatus = "RUNNING" | "SUCCESS" | "FAILED";
export interface Restore {
  id: string;
  kind: RestoreKind;
  /** The database the row is homed on; for cross-database restores the other side. A PITR replay is homed on
   *  the SOURCE and names the NEW database it produced, the moment restored to, and the base used. */
  databaseId: string;
  sourceDatabaseId: string | null;
  targetDatabaseId: string | null;
  targetTime: string | null;
  baseBackupId: string | null;
  status: RestoreStatus;
  exitCode: number | null;
  errorTail: string | null;
  backupId: string | null;
  createdAt: string;
  completedAt: string | null;
}

/** `docker system df` breakdown (GET /servers/:id/disk-usage) — docker's own human sizes, surfaced as-is. */
export interface DiskUsageRow {
  totalCount: number;
  active: number;
  size: string;
  reclaimable: string;
}
export interface DiskUsage {
  images: DiskUsageRow;
  containers: DiskUsageRow;
  volumes: DiskUsageRow;
  buildCache: DiskUsageRow;
}

/** Persisted GPU detection snapshot (GET /servers/:id/gpus). `inventory: null` + readiness "unknown" = never probed — NOT "no GPU". */
export interface GpuDevice {
  index: number | null;
  uuid: string | null;
  name: string;
  vendor: "nvidia" | "amd" | "intel" | "other";
  kind: "gpu" | "virtual";
  memoryMb: number | null;
  driver: string | null;
  pci: string | null;
  source: "nvidia-smi" | "pci";
}
export interface GpuInventory {
  v: 1;
  gpus: GpuDevice[];
  runtimes: string[];
  defaultRuntime: string | null;
  nvidiaRuntime: boolean;
  nvidiaDriverLoaded: boolean;
  nvidiaModuleVersion: string | null;
  error: string | null;
}
export type GpuReadiness = "unknown" | "none" | "driver_missing" | "runtime_missing" | "ready" | "non_nvidia" | "probe_failed";
export interface GpuReport {
  inventory: GpuInventory | null;
  readiness: GpuReadiness;
  checkedAt: string | null;
  ageSeconds: number | null;
  stale: boolean;
  ttlSeconds: number;
  throttled?: boolean;
  busy?: boolean;
}

// ── Traffic Analytics (proxy access-log based, read-level, team-scoped) ─────────────────────────────
export interface TrafficTotals {
  requests: number;
  s2xx: number;
  s3xx: number;
  s4xx: number;
  s5xx: number;
  bytes: number;
  botRequests: number;
  humanRequests: number;
  /** Overall p95 latency (ms) over the range; 0 = no latency data. */
  p95Ms: number;
  /** Distinct visitors over the range (merged HyperLogLog estimate, about +-1.6%); 0 = none. Absent on an older hub. */
  uniqueVisitors?: number;
}
/** GET /traffic/summary: index i of every series is the bucket starting at times[i] (unix ms). */
export interface TrafficSummary {
  range: string;
  stepSec: number;
  times: number[];
  requests: number[];
  s2xx: number[];
  s3xx: number[];
  s4xx: number[];
  s5xx: number[];
  bytes: number[];
  /** p95 latency (ms) per bucket; 0 where a bucket has no latency data. */
  p95Ms: number[];
  /** Distinct visitors per bucket (each its own estimate, NOT additive); 0 = none. Absent on an older hub. */
  uniqueVisitors?: number[];
  totals: TrafficTotals;
}
export type TrafficBreakdownDim = "browser" | "os" | "device" | "referrer" | "city" | "network";
/** GET /traffic/breakdown: top keys of one visitor dimension; `other` = overflow the agent folded into "(other)". */
export interface TrafficBreakdown {
  range: string;
  dim: TrafficBreakdownDim;
  items: { key: string; requests: number }[];
  other: { requests: number };
}
export interface TrafficPaths {
  range: string;
  paths: { path: string; requests: number; bytes: number }[];
  other: { requests: number; bytes: number }; // overflow the agent folded into "(other)"
}
export interface TrafficCountries {
  range: string;
  countries: { country: string; requests: number }[]; // ISO-3166 alpha-2; "ZZ" = overflow bucket (countries beyond the per-minute top set) or an invalid code; requests with no resolved country are not counted here
}
export interface TrafficDomainRow {
  domain: string;
  appId: string | null;
  appName: string | null;
  requests: number;
}
export type TrafficApplyState = "applied" | "deferred" | "failed" | "not-in-pool" | "cluster-shared";
export interface TrafficAnalyticsState {
  trafficAnalytics: boolean;
  apply: TrafficApplyState;
  applyError: string | null;
}

/** PITR (point-in-time recovery) switch state for a Postgres database — GET /databases/:id/pitr. */
export type PitrState = "OFF" | "ARMING" | "ACTIVE";
export interface PitrStatus {
  enabled: boolean;
  state: PitrState;
  enabledAt: string | null;
  destinationType: "LOCAL" | "S3";
  /** ACTIVE but no base backup taken since enabling — WAL alone cannot anchor a recovery. */
  needsBaseBackup: boolean;
}

/** The recoverable window — GET /databases/:id/pitr/window. Both bounds are approximate (upper bounds). */
export interface PitrWindow {
  earliest: string | null;
  latest: string | null;
  approx: true;
  reason: "not_enabled" | "no_base" | "agent_offline" | "capability" | "list_failed" | "no_wal" | null;
  bases: { id: string; from: string; to: string; startLsn: string; timeline: number }[];
}

// ── Fleet rollouts (GET/POST /rollouts) ──
export type RolloutStatus = "RUNNING" | "HALTED" | "ROLLING_BACK" | "COMPLETED" | "ROLLED_BACK" | "ROLLBACK_FAILED" | "CANCELLED";
export type RolloutTargetStatus = "PENDING" | "DEPLOYING" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "SKIPPED" | "REVERTING" | "ROLLED_BACK" | "ROLLBACK_FAILED";
export interface RolloutConfig {
  canary: number;
  steps: number[];
  concurrency: number;
  maxFailuresPerWave: number;
  bakeSec: number;
  dispatchTimeoutSec: number;
  waitOnlineSec: number;
  allowUngated: boolean;
  noCache: boolean;
}
export interface RolloutTarget {
  id: string;
  appId: string;
  serverId: string;
  label: string;
  wave: number;
  position: number;
  status: RolloutTargetStatus;
  attempt: number;
  deploymentId: string | null;
  baselineDeploymentId: string | null;
  rollbackDeploymentId: string | null;
  outcome: string | null;
  detail: string | null;
  dispatchedAt: string | null;
  finishedAt: string | null;
}
export interface Rollout {
  id: string;
  teamId: string;
  createdBy: string;
  name: string | null;
  kind: string;
  status: RolloutStatus;
  haltReason: string | null;
  haltDetail: Record<string, unknown> | null;
  config: RolloutConfig;
  currentWave: number;
  waveCount: number;
  waveSizes: number[];
  bakeUntil: string | null;
  createdAt: string;
  finishedAt: string | null;
  summary: { total: number; pending: number; deploying: number; succeeded: number; failed: number; skipped: number; cancelled: number };
  targets: RolloutTarget[];
}
export interface RolloutPlan {
  teamId: string;
  waveSizes: number[];
  targets: { appId: string; name: string; serverId: string; wave: number | null; blocked: string | null; warnings: string[] }[];
  blocked: number;
}
export interface RolloutCreateInput {
  name?: string;
  appIds: string[];
  config: Partial<RolloutConfig>;
}

// ── Master-key rotation (GET /instance/secrets-key) ──
export interface SecretsKeyCounts {
  current: number;
  stale: number;
  unreadable: number;
}
export type SecretsKeyRole = "active" | "decrypt-only" | "root" | "retired";
export type SecretsKeyBlockedReason = "referenced" | "grace" | "running" | "degraded";
export interface SecretsKeyInfo {
  id: string;
  source: "env" | "ring";
  role: SecretsKeyRole;
  createdAt: string | null;
  activatedAt: string | null;
  demotedAt: string | null;
  retiredAt: string | null;
  referenced: number;
  retirable: boolean;
  retireBlockedReason: SecretsKeyBlockedReason | null;
}
export interface SecretsKeyStatus {
  currentKeyId: string;
  previousKeyIds: string[];
  /** Keyring epoch (0 until an owner first rotates). */
  epoch: number;
  /** Non-null when a stored data key cannot be unwrapped with the configured root key (rotation is blocked). */
  degraded: string | null;
  /** Stored values counted per key id ("legacy" for unprefixed ciphertexts). */
  byKey: Record<string, number>;
  /** True when no stored secret is under a keyring data key (an older release can read everything). */
  downgradeSafe: boolean;
  keys: SecretsKeyInfo[];
  models: ({ model: string } & SecretsKeyCounts)[];
  totals: SecretsKeyCounts;
  hmacRowsOnOldKeys: { model: string; column: string; count: number | null }[];
  previousKeyRemovable: boolean;
  running: boolean;
  lastRun: {
    startedAt: string;
    finishedAt: string | null;
    actor: string;
    rewritten: number;
    alreadyCurrent: number;
    unreadable: number;
    skipped: number;
    errors: number;
    unreadableRefs: string[];
    error: string | null;
  } | null;
}

/** One label Tugra itself applies (read-only). `value` is null when `masked` (basic-auth hashes, forward-auth address). */
export interface AppliedLabel {
  scope: string; // "container" | "service:<name>" | "swarm-service"
  key: string;
  value: string | null;
  masked: boolean;
  purpose: "traefik_routing" | "proxy_network_pin" | "alias" | "config_mount_fp";
}

/** GET /apps/:id/labels — the labels Tugra applies plus the custom ones, with the rules the editor validates against. */
export interface AppLabelsView {
  engine: "docker" | "compose" | "swarm";
  editable: boolean;
  editableReason: "compose" | "preview" | null;
  applyMode: "next_deploy";
  tugra: AppliedLabel[];
  custom: { key: string; value: string }[];
  fromDockerOptions: { key: string; value: string }[];
  /** Reserved label namespaces (lower-case, with the trailing dot) — the server is the single source. */
  reservedPrefixes: string[];
  limits: { maxCount: number; keyMax: number; valueMax: number; totalBytes: number; keyPattern: string };
  notes: ("rolling_health_labels" | "needs_domain" | "compose_user_labels" | "image_labels_not_shown" | "swarm_container_labels" | "swarm_runtime_labels")[];
}

/** POST /apps/:id/compose-preview: the REDACTED `docker compose config --no-interpolate` output. */
export interface ComposePreviewResult {
  resolvedCompose: string;
  services: string[];
  sha256: string;
  redactions: number;
  warnings: string[];
  generatedAt: string;
}

// ── App move (relocate an app + its data to another server) ──
export type AppMovePhase = "QUEUED" | "PRECHECK" | "STOPPING_SOURCE" | "TRANSFERRING" | "DEPLOYING" | "FINALIZING" | "COMPLETED" | "ROLLING_BACK" | "ROLLED_BACK" | "FAILED";
export type MoveAckKey = "hostMounts" | "externalVolumes" | "dropPrivilegedOptions" | "dropGpus" | "resetCpuset" | "hostPortChanged" | "domainChanges";
export type MoveAcks = Partial<Record<MoveAckKey, boolean>>;

export interface MoveBlocker {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  /** The operator can accept this consequence (tick the matching acknowledgement). */
  ack?: boolean;
}
export interface MoveWarning {
  code: string;
  details?: Record<string, unknown>;
}
export interface MovePlanVolume {
  name: string;
  dockerName: string;
  kind: "app" | "compose";
  sizeBytes: number | null;
  state: "move" | "absent_skip" | "external_skip";
}
export interface MovePreflightResult {
  ok: boolean;
  blockers: MoveBlocker[];
  warnings: MoveWarning[];
  requiredAcks: MoveAckKey[];
  plan: {
    cheap: boolean;
    volumes: MovePlanVolume[];
    totalBytes: number;
    partBytes: number;
    estimatedParts: number;
    sourceStagingFreeBytes: number | null;
    targetFreeBytes: number | null;
    estimatedDowntimeSec: { low: number; high: number };
    domain: { kind: string; from: string | null; to: string | null };
    hostPort: { from: number | null; to: number | null };
    targetIp: string | null;
    link: { ok: boolean; mbps: number | null } | null;
  };
}
export interface AppMoveVolume {
  name: string;
  state: string;
  sizeBytes: number | null;
  parts: number;
  partsDone: number;
  bytesDone: number;
}
export interface AppMove {
  id: string;
  appId: string;
  appName: string;
  phase: AppMovePhase;
  prevStatus: string;
  sourceServerId: string;
  targetServerId: string;
  volumes: AppMoveVolume[];
  progress: { volumeIndex: number; volumeCount: number; bytesDone: number; bytesTotal: number };
  warnings: MoveWarning[];
  failureReason: string | null;
  failurePhase: AppMovePhase | null;
  deploymentId: string | null;
  cutoverAt: string | null;
  finishedAt: string | null;
  archiveUntil: string | null;
  sourcePurgedAt: string | null;
  createdAt: string;
  canCancel: boolean;
  needsAttention: boolean;
  /** An apply rollback snapshot is kept on the new server (the only intact copy of data an apply wiped). */
  snapshotKept?: boolean;
  /** writer-only (null for read-only members) */
  plan: Record<string, unknown> | null;
  acks: Record<string, boolean> | null;
  logTail: string | null;
}

// ── object (S3/MinIO) migration ──
export type ObjectMigrationStatus = "DRAFT" | "PREFLIGHTED" | "SEEDING" | "SEEDED" | "FINALIZING" | "FINAL" | "VERIFYING" | "DONE" | "FAILED";
export type ObjectBucketStatus = "PENDING" | "QUEUED" | "SEEDING" | "SEEDED" | "FINALIZING" | "FINAL" | "VERIFIED" | "DIFFERS" | "FAILED";
export interface ObjectMigrationWarning {
  code: string;
  level: "blocker" | "warn" | "info";
  bucket?: string;
}
export interface ObjectBucketView {
  idx: number;
  srcBucket: string;
  dstBucket: string;
  exclude: string[];
  selected: boolean;
  status: ObjectBucketStatus;
  srcObjects: number | null;
  srcBytes: number | null;
  dstObjects: number | null;
  dstBytes: number | null;
  doneObjects: number | null;
  doneBytes: number | null;
  diffMissing: number | null;
  diffDiffer: number | null;
  diffExtra: number | null;
  versioning: string | null;
  configSummary: { policy: boolean; lifecycle: boolean; tags: boolean } | null;
  configStatus: string | null;
  lastError: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}
/** No credentials, ever: endpoints, names, counts and fixed codes only. */
export interface ObjectMigrationView {
  id: string;
  name: string;
  teamId: string;
  targetServerId: string;
  status: ObjectMigrationStatus;
  phase: "seed" | "final" | null;
  srcEndpoint: string;
  dstEndpoint: string;
  preserve: boolean;
  removeExtraneous: boolean;
  mergeIntoExisting: boolean;
  cancelRequested: boolean;
  warnings: ObjectMigrationWarning[];
  buckets: ObjectBucketView[];
  canWrite: boolean;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}
export interface CreateObjectMigrationInput {
  name: string;
  targetServerId: string;
  preserve: boolean;
  source: { endpoint: string; accessKey: string; secretKey: string };
  destination: { endpoint: string; accessKey: string; secretKey: string };
}
export interface StartObjectMigrationInput {
  phase: "seed" | "final";
  acknowledgeWritesFrozen?: boolean;
  removeExtraneous?: boolean;
  mergeIntoExisting?: boolean;
}

// ── P7 guided migration runs (mirrors hub-api migration-runs/core/dto.ts; secret-free, codes + params only) ──
export type MigrationRunStatus =
  | "QUEUED" | "RUNNING" | "WAITING" | "PAUSED" | "ABORTING" | "ABORTED" | "ROLLING_BACK" | "ROLLED_BACK" | "REVERSING" | "REVERSED" | "COMPLETED" | "FAILED" | "DRY_RUN_DONE";
export type MigrationRunStepStatus = "PENDING" | "RUNNING" | "WAITING_OPERATOR" | "WAITING_APPROVAL" | "WAITING_TIMER" | "PASSED" | "FAILED" | "SKIPPED" | "COMPENSATED";
export type MigrationRunStepKey =
  | "PREFLIGHT" | "IMPORT" | "DNS_PREPARE" | "DATA_SEED" | "FREEZE" | "DATA_FINAL" | "REMAP_ENV" | "DEPLOY_DARK" | "TLS_PREISSUE" | "VERIFY" | "CUTOVER" | "OBSERVE" | "FINALIZE" | "DECOMMISSION";
export type MigrationRunStepKind = "auto" | "operator" | "approval" | "timer";
export type MigrationRunRollbackClass = "FREE" | "UNDOABLE" | "LOSSY_AFTER_PONR" | "IRREVERSIBLE";
export type MigrationRunMode = "copy" | "takeover";
export type MigrationRunTopology = "two-box" | "swap-proxy";
export type MigrationRunEvidenceKind = "hub-verified" | "migrator-reported" | "operator-attested" | "source-api-reported" | "host-loop-reported";
export type MigrationRunCheckStatus = "pass" | "fail" | "warn" | "unknown";
export type MigrationRunOwnerInputKey =
  | "acmeEmail" | "allowBind" | "allowLiveShapeProbe" | "sourceController" | "minioPolicy" | "workerPolicy" | "unlistedDbPolicy" | "orphanVolumePolicy";
export type MigrationRunMinioPolicy = "hold" | "mirror" | "external";
export type MigrationRunWorkerPolicy = "hold-dark" | "start-dark" | "exclude";
export type MigrationRunUnlistedDbPolicy = "block" | "carry" | "skip";
export type MigrationRunOrphanVolumePolicy = "block" | "skip";
export type MigrationRunSourceRunner = "operator" | "agent" | "coolify-host-loop";
export type MigrationRunCommandKind = "migrator" | "host-loop" | "inventory";
export type MigrationRunLargeDbMode = "refuse" | "stream-logical";
/** Which imported compose services DEPLOY_DARK starts, before the apps that need them. */
export type MigrationRunServiceStart = "dependencies" | "none" | "all";
export type MigrationRunSourceVersionVerdict = "supported" | "newer" | "too-old" | "unknown" | "unchecked";
/** Source server (Coolify server uuid) to Tugra target server id. */
export type MigrationRunServerMap = Record<string, string>;
export type MigrationRunConfirmKind = "none" | "run-id" | "target-server" | "target-servers" | "target-server+source-host" | "target-servers+source-host" | "source-host";
export type MigrationRunProgressUnit = "item" | "byte" | "volume" | "host" | "app" | "database" | "bucket" | "second";

export type MigrationRunParamValue = string | number | boolean | null | Array<string | number | boolean | null>;
export type MigrationRunParams = Record<string, MigrationRunParamValue>;

export interface MigrationRunGateCheck {
  id: string;
  status: MigrationRunCheckStatus;
  code: string;
  params?: MigrationRunParams;
  subject?: string;
  evidence?: MigrationRunEvidenceKind;
  ownerInput?: MigrationRunOwnerInputKey;
  /** The attestation check ids an operator may record for this check (one row per check and subject). */
  attestable?: string[];
  ackable?: boolean;
  acked?: boolean;
}
export interface MigrationRunApprovalBinding {
  inputHash: string;
  ponr: boolean;
  confirm: MigrationRunConfirmKind;
  ttlSec: number | null;
  requiresDataRisk: boolean;
  ackable: string[];
  requiredAcks: string[];
  review: MigrationRunParams;
}
export type MigrationRunWait =
  | { kind: "operator"; code: string; params?: MigrationRunParams; offersCommand?: boolean; commandKind?: MigrationRunCommandKind; attest?: string[] }
  | { kind: "approval"; binding: MigrationRunApprovalBinding }
  | { kind: "timer"; notBefore: string; code: string; params?: MigrationRunParams };
export interface MigrationRunGate {
  passed: boolean;
  checks: MigrationRunGateCheck[];
  wait?: MigrationRunWait;
}
export interface MigrationRunApproval {
  byUserId: string;
  at: string;
  boundHash: string;
  acks: string[];
  acceptDataRisk: boolean;
  expiresAt: string | null;
}
export interface MigrationRunDryRunItem {
  code: string;
  level: "info" | "warn" | "block" | "unknown";
  subject?: string;
  params?: MigrationRunParams;
}
export interface MigrationRunProgress {
  done: number;
  total: number;
  unit: MigrationRunProgressUnit;
  etaSec?: number | null;
  dryRun?: MigrationRunDryRunItem[];
}
export interface MigrationRunStepEvidence {
  attestations: Array<{ checkId: string; subject?: string; note?: string; byUserId: string; at: string }>;
  attachments: Array<{ kind: "object-migration"; resourceId: string; byUserId: string; at: string }>;
}
export interface MigrationRunStepAllowed {
  approve: boolean;
  retry: boolean;
  skip: boolean;
  evidence: boolean;
  attach: boolean;
  command: boolean;
}
export interface MigrationRunStepView {
  key: MigrationRunStepKey;
  idx: number;
  kind: MigrationRunStepKind;
  status: MigrationRunStepStatus;
  rollbackClass: MigrationRunRollbackClass;
  attempt: number;
  skippedCode: string | null;
  gate: MigrationRunGate | null;
  approval: MigrationRunApproval | null;
  wait: MigrationRunWait | null;
  progress: MigrationRunProgress | null;
  evidence: MigrationRunStepEvidence;
  notBefore: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
  allowed: MigrationRunStepAllowed;
}
export interface MigrationRunNextAction {
  kind: "operator" | "approval" | "timer" | "gate" | "session" | "paused" | "failed" | "engine" | "none";
  stepKey: MigrationRunStepKey | null;
  code: string;
  params?: MigrationRunParams;
  since: string;
  notBefore?: string | null;
  approval?: MigrationRunApprovalBinding;
  attest?: string[];
  offersCommand?: boolean;
}
export interface MigrationRunAllowed {
  start: boolean;
  pause: boolean;
  resume: boolean;
  abort: boolean;
  cleanup: boolean;
  reverse: boolean;
  decommission: boolean;
  setInputs: boolean;
  sourceSession: boolean;
}
export interface MigrationRunInputRecord<T> {
  value: T | "unknown";
  source: "request" | "default" | "derived";
  setBy: string | null;
  at: string;
}
export interface MigrationRunOwnerInputs {
  acmeEmail?: MigrationRunInputRecord<string>;
  allowBind?: MigrationRunInputRecord<boolean>;
  allowLiveShapeProbe?: MigrationRunInputRecord<boolean>;
  sourceController?: MigrationRunInputRecord<"manual" | "api" | "agent">;
  minioPolicy?: MigrationRunInputRecord<MigrationRunMinioPolicy>;
  workerPolicy?: MigrationRunInputRecord<MigrationRunWorkerPolicy>;
  unlistedDbPolicy?: MigrationRunInputRecord<MigrationRunUnlistedDbPolicy>;
  orphanVolumePolicy?: MigrationRunInputRecord<MigrationRunOrphanVolumePolicy>;
}
export interface MigrationRunHostLoopOptions {
  keyDir: string;
  parallel: number;
  connectTimeoutSec: number;
  retries: number;
}
export interface MigrationRunOptions {
  ttlPolicy: "wait" | "skip-ack";
  deployWaves: "single" | "earlyStateless" | "earlyBuild";
  warmDbSeed: boolean;
  stopSource: boolean;
  sourceRunner: MigrationRunSourceRunner;
  hostLoop?: MigrationRunHostLoopOptions;
  deployConcurrency?: number;
  largeDbMode?: MigrationRunLargeDbMode;
  serviceStart?: MigrationRunServiceStart;
  certs: "none" | "seed";
  acceptHttp01Gap: boolean;
  freezeAt?: string;
  observeMinutes: number;
  manualFinalize: boolean;
  batchSize: number;
  intervalSec: number;
  dnsCredentialId?: string;
  healthPath?: string;
  rowCountMode: "exact" | "estimate";
  decommissionMinAgeHours: number;
  stuckOperatorMinutes: number;
}
export interface MigrationRunWindowEstimate {
  freezeToFlipSec: number | null;
  basis: Array<{ code: string; params?: MigrationRunParams }>;
  estimatedAt: string;
}
export interface MigrationRunFailure {
  step: MigrationRunStepKey | null;
  code: string;
}
export interface MigrationRunView {
  id: string;
  teamId: string;
  actorId: string;
  targetServerId: string;
  targetServerName: string | null;
  /** Source server (Coolify server uuid) to target server id; `{}` for a single-target run. */
  serverMap: MigrationRunServerMap;
  /** Every target server of the run, the default first. */
  targetServers: Array<{ serverId: string; serverName: string | null; primary: boolean }>;
  sourceKind: ImportRemoteKind;
  sourceHost: string | null;
  sourceVersion: string | null;
  sourceVersionVerdict: MigrationRunSourceVersionVerdict;
  campaign: string | null;
  /** When the source health baseline was captured; null until then. */
  baselineAt: string | null;
  opId: string | null;
  opHistory: string[];
  planHash: string;
  mode: MigrationRunMode;
  topology: MigrationRunTopology;
  dryRun: boolean;
  promotedFromId: string | null;
  status: MigrationRunStatus;
  currentStep: MigrationRunStepKey | null;
  ponrAt: string | null;
  pauseRequested: boolean;
  abortRequested: boolean;
  options: MigrationRunOptions;
  inputs: MigrationRunOwnerInputs;
  windowEstimate: MigrationRunWindowEstimate | null;
  freezeStartedAt: string | null;
  freezeEndedAt: string | null;
  measuredDowntimeSec: number | null;
  failure: MigrationRunFailure | null;
  nextAction: MigrationRunNextAction;
  allowed: MigrationRunAllowed;
  steps: MigrationRunStepView[];
  eventSeq: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}
export interface MigrationRunSummary {
  id: string;
  teamId: string;
  targetServerId: string;
  targetServerName: string | null;
  targetServerCount: number;
  sourceKind: ImportRemoteKind;
  sourceHost: string | null;
  sourceVersion: string | null;
  campaign: string | null;
  mode: MigrationRunMode;
  topology: MigrationRunTopology;
  dryRun: boolean;
  status: MigrationRunStatus;
  currentStep: MigrationRunStepKey | null;
  ponrAt: string | null;
  stepsPassed: number;
  stepsTotal: number;
  nextActionKind: MigrationRunNextAction["kind"];
  failure: MigrationRunFailure | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}
export interface MigrationRunEvent {
  seq: number;
  at: string;
  stepKey: MigrationRunStepKey | null;
  level: "info" | "warn" | "error";
  code: string;
  params: MigrationRunParams | null;
  actorId: string | null;
}
export interface MigrationRunEventsPage {
  events: MigrationRunEvent[];
  lastSeq: number;
  hasMore: boolean;
}
/** `POST /migration-runs` body (the apply fields, frozen server-side, plus the run switches). */
export interface MigrationRunCreateInput extends ImportApplyExtras {
  sessionId: string;
  sourceKind: ImportRemoteKind;
  targetServerId: string;
  environmentId?: string;
  planHash: string;
  mapping?: ImportMappingDoc;
  mappingHash?: string;
  mode?: MigrationRunMode;
  topology?: MigrationRunTopology;
  dryRun?: boolean;
  options?: Partial<MigrationRunOptions>;
  inputs?: Partial<{
    acmeEmail: string | "unknown";
    allowBind: boolean | "unknown";
    allowLiveShapeProbe: boolean | "unknown";
    sourceController: "manual" | "api" | "agent" | "unknown";
    minioPolicy: MigrationRunMinioPolicy | "unknown";
    workerPolicy: MigrationRunWorkerPolicy | "unknown";
    unlistedDbPolicy: MigrationRunUnlistedDbPolicy | "unknown";
    orphanVolumePolicy: MigrationRunOrphanVolumePolicy | "unknown";
  }>;
  /** Multi-host placement: source server uuid to Tugra target server id (the run's `targetServerId` stays the default). */
  serverMap?: MigrationRunServerMap;
  /** Groups the runs of one campaign. */
  campaign?: string;
}
export type MigrationRunInputsRequest = NonNullable<MigrationRunCreateInput["inputs"]>;
export interface MigrationRunApproveInput {
  boundHash: string;
  acks: string[];
  confirmName?: string;
  acceptDataRisk?: boolean;
}
export interface MigrationRunCommandResult {
  stepKey: MigrationRunStepKey;
  /** Which command this is; absent on a hub that predates the host-loop runner (read as `migrator`). */
  kind?: MigrationRunCommandKind;
  opId: string;
  expiresAt: string;
  command: string;
  commands?: { dryRun: string; run: string; resume: string };
  shownOnce: true;
}
export interface MigrationRunReport {
  runId: string;
  generatedAt: string;
  status: MigrationRunStatus;
  mode: MigrationRunMode;
  topology: MigrationRunTopology;
  dryRun: boolean;
  source: { kind: ImportRemoteKind; host: string | null; version?: string | null };
  target: { serverId: string; serverName: string | null };
  /** Every target server of the run (default first); empty in a report stored before multi-host runs. */
  targets?: Array<{ serverId: string; serverName: string | null }>;
  campaign?: string | null;
  ponrAt: string | null;
  window: { estimatedSec: number | null; measuredSec: number | null };
  steps: Array<{ key: MigrationRunStepKey; status: MigrationRunStepStatus; attempts: number; durationSec: number | null; code: string | null }>;
  items: Array<{ kind: "app" | "database" | "service" | "volume" | "bucket" | "domain"; name: string; outcome: "moved" | "skipped" | "acked" | "failed" | "not-cut-over"; code: string | null; evidence: MigrationRunEvidenceKind | null }>;
  evidenceSummary: Partial<Record<MigrationRunEvidenceKind, number>>;
  manual: Array<{ code: string; params?: MigrationRunParams }>;
}

/** `GET /migration-runs/:id/safety-hints`: facts attested by the people who can see the SOURCE HOST (secret-free). */
export interface MigrationRunSafetyHints {
  imagePins: Array<{ image: string; scope: string; digest: string; evidence: string }>;
  workerMarks: Array<{ itemRef: string; role: "job-runner" | "web" }>;
}
