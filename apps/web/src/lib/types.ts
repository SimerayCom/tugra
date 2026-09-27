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

// ── Docker Swarm formation (Phase2) ──
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

/** A structured Swarm placement rule (FLEET-D). */
export type PlacementConstraint =
  | { type: "hostname"; op: "eq" | "ne"; value: string }
  | { type: "nodeId"; op: "eq" | "ne"; value: string }
  | { type: "role"; op: "eq" | "ne"; value: "manager" | "worker" }
  | { type: "label"; op: "eq" | "ne"; key: string; value: string };
export interface Placement {
  constraints: PlacementConstraint[];
  spreadLabelKey: string | null;
}
export interface SwarmView {
  clusterId: string;
  swarmStatus: SwarmStatus;
  managerServerId: string | null;
  swarmLastError: string | null;
  nodes: SwarmNodeView[];
  live: SwarmLiveNode[] | null;
}

/** Public onboarding state (GET /instance/status) — read before login to gate the welcome flow. */
export interface InstanceStatus {
  /** True once the first user has completed setup; false → a fresh install needs the owner account. */
  initialized: boolean;
  allowRegistration: boolean;
  edition: string;
  /** OIDC single sign-on is enabled + fully configured on a Pro+ edition → show the SSO login button. */
  ssoEnabled: boolean;
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
  /** Whether patch releases are applied automatically (the updater is a later slice). */
  autoUpdate: boolean;
}

/** Result of POST /instance/update (starting the updater). `started` = queued for the sidecar. */
export interface InstanceUpdateApply {
  status: "started" | "up-to-date" | "in-progress" | "unconfigured" | "error" | "notify-only" | "needs-intermediate";
  targetVersion: string | null;
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
  cleanupVolumes: boolean;
  lastCleanupAt: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  seal: string | null;
  tags: string[];
  capabilities: string[]; // granted agent capabilities; [] = all
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
}

export type MetricsRange = "1h" | "6h" | "24h" | "7d";

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
}

export interface ServerContainers {
  containers: ContainerInventoryRow[];
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

export type AppStatus = "NEW" | "RUNNING" | "STOPPED" | "FAILED";

export type AppSource = "IMAGE" | "GIT" | "COMPOSE";
export type BuildType = "NIXPACKS" | "DOCKERFILE" | "STATIC" | "RAILPACK" | "HEROKU";

export interface AppVolume {
  name: string;
  path: string;
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

export interface Application {
  id: string;
  name: string;
  templateSlug: string | null;
  templateLogo: string | null;
  source: AppSource;
  image: string | null;
  gitUrl: string | null;
  gitBranch: string | null;
  buildType: BuildType;
  buildCommand: string | null;
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
  volumes: AppVolume[];
  hasGitToken: boolean;
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
  domainRedirect: "www" | "root" | null;
  securityHeaders: boolean;
  forwardAuth: string | null;
  https: boolean;
  domainKind: string;
  exposeMode: string;
  tunnelExposed: boolean;
  certType: string;
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

export type DeploymentStatus = "RUNNING" | "SUCCESS" | "FAILED";

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
