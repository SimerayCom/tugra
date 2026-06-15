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

export interface Application {
  id: string;
  name: string;
  image: string;
  serverId: string;
  teamId: string;
  status: AppStatus;
  hostPort: number | null;
  containerPort: number | null;
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
  createdAt: string;
}
