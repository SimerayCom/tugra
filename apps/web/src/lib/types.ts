export type Role = "OWNER" | "ADMIN" | "VIEWER";
export type ServerStatus = "PENDING" | "ONLINE" | "OFFLINE";
export type ProxyStatus = "running" | "stopped" | "absent";

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

export interface PublicUser {
  id: string;
  email: string;
  name: string | null;
  twoFaEnabled: boolean;
}

export interface ServerView {
  id: string;
  name: string;
  status: ServerStatus;
  teamId: string;
  hostname: string | null;
  os: string | null;
  osVersion: string | null;
  arch: string | null;
  kernel: string | null;
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
  role: Role;
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
  rebootRequired: boolean;
  packages: UpgradablePackage[];
  count: number;
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
}

export interface AuditEntry {
  id: string;
  actor: string;
  action: string;
  target: string | null;
  meta: unknown;
  createdAt: string;
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
}

export interface SourceRepo {
  fullName: string;
  cloneUrl: string;
  private: boolean;
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
  appCount: number;
  dbCount: number;
  resources?: ProjectResource[];
  createdAt: string;
}

export interface Project {
  id: string;
  teamId: string;
  name: string;
  environments: Environment[];
  role: Role;
  canWrite: boolean;
  createdAt: string;
}

export interface DomainView {
  id: string;
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

export interface Application {
  id: string;
  name: string;
  source: AppSource;
  image: string | null;
  gitUrl: string | null;
  gitBranch: string | null;
  buildType: BuildType;
  buildCommand: string | null;
  outputDir: string | null;
  composeFile: string | null;
  healthCmd: string | null;
  memoryMb: number | null;
  cpus: number | null;
  deployTimeoutSec: number | null;
  dockerOptions: string | null;
  volumes: AppVolume[];
  hasGitToken: boolean;
  registryUrl: string | null;
  registryUser: string | null;
  environmentId: string | null;
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
  role: Role;
  canWrite: boolean;
  createdAt: string;
}

export interface VolumeBackup {
  id: string;
  volumeName: string;
  status: BackupStatus;
  filename: string;
  sizeBytes: string | null;
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
  logs: string | null;
  exitCode: number | null;
  imageTag: string | null;
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
  | "CLICKHOUSE";
export type DbStatus = "NEW" | "RUNNING" | "STOPPED" | "FAILED";

export interface Database {
  id: string;
  name: string;
  engine: DbEngine;
  version: string;
  environmentId: string | null;
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

export interface ApiToken {
  id: string;
  name: string;
  prefix: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface SharedVariable {
  id: string;
  teamId: string;
  key: string;
  value: string | null;
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
  createdBy: string;
  createdAt: string;
  completedAt: string | null;
}
