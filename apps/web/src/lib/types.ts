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
