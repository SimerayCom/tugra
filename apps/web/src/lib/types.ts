export type Role = "OWNER" | "ADMIN" | "VIEWER";
export type ServerStatus = "PENDING" | "ONLINE" | "OFFLINE";

export interface Team {
  id: string;
  name: string;
  role: Role;
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
  lastSeenAt: string | null;
  createdAt: string;
  seal: string | null;
  role: Role;
  canWrite: boolean;
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

export type MonitorType = "HTTP" | "TCP";
export type MonitorStatus = "UP" | "DOWN" | "PENDING";

export interface Monitor {
  id: string;
  name: string;
  type: MonitorType;
  target: string;
  status: MonitorStatus;
  intervalSec: number;
  enabled: boolean;
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

export type AppSource = "IMAGE" | "GIT";
export type BuildType = "NIXPACKS" | "DOCKERFILE";

export interface Application {
  id: string;
  name: string;
  source: AppSource;
  image: string | null;
  gitUrl: string | null;
  gitBranch: string | null;
  buildType: BuildType;
  serverId: string;
  teamId: string;
  status: AppStatus;
  hostPort: number | null;
  containerPort: number | null;
  domain: string | null;
  https: boolean;
  url: string | null;
  webhookToken: string | null;
  webhookSecret: string | null;
  envCount: number;
  role: Role;
  canWrite: boolean;
  createdAt: string;
}

export type DeploymentStatus = "RUNNING" | "SUCCESS" | "FAILED";

export interface Deployment {
  id: string;
  status: DeploymentStatus;
  logs: string | null;
  exitCode: number | null;
  imageTag: string | null;
  createdAt: string;
}

export type DbEngine = "POSTGRES" | "MYSQL" | "REDIS" | "MONGO";
export type DbStatus = "NEW" | "RUNNING" | "STOPPED" | "FAILED";

export interface Database {
  id: string;
  name: string;
  engine: DbEngine;
  version: string;
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
  backupEnabled: boolean;
  backupIntervalHours: number | null;
  backupRetention: number;
  backupDestinationId: string | null;
  role: Role;
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
  createdBy: string;
  createdAt: string;
  completedAt: string | null;
}
