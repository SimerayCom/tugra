/**
 * @tugra/shared — types shared between the hub and the agent.
 * The agent (Go) mirrors these shapes (same JSON field names); keep them in sync.
 */

export const PROTOCOL_VERSION = 1;

export type ServerStatus = "PENDING" | "ONLINE" | "OFFLINE";

/** A point-in-time snapshot the agent streams to the hub. */
export interface MetricsSample {
  ts: number; // unix ms
  cpu: number; // 0..100
  memUsed: number; // bytes
  memTotal: number; // bytes
  diskUsed: number; // bytes
  diskTotal: number; // bytes
  netRx: number; // bytes/s
  netTx: number; // bytes/s
}

// ---- Hub -> Agent --------------------------------------------------------

/** Sent right after the socket opens; the agent signs `nonce` to authenticate. */
export interface ChallengeMsg {
  type: "challenge";
  nonce: string;
}

/** Enrollment result: the server's id + its signed identity ("seal"). */
export interface EnrolledMsg {
  type: "enrolled";
  serverId: string;
  seal: string;
}

/** Re-auth (reconnect) accepted. */
export interface AuthOkMsg {
  type: "auth_ok";
  serverId: string;
}

export interface ErrorMsg {
  type: "error";
  message: string;
}

// ---- Agent -> Hub --------------------------------------------------------

/** First-time enrollment, using a one-time enroll token. */
export interface EnrollMsg {
  type: "enroll";
  protocol: number;
  token: string;
  publicKey: string; // base64(SPKI DER) of the agent's ed25519 public key
  agentVersion: string;
  hostname: string;
  fingerprint: string;
}

/** Reconnect of an already-enrolled agent: signs the challenge nonce. */
export interface AuthMsg {
  type: "auth";
  protocol: number;
  serverId: string;
  signature: string; // base64(ed25519 signature over the challenge nonce)
}

/** Periodic metrics. */
export interface MetricsMsg {
  type: "metrics";
  sample: MetricsSample;
}

/** Liveness ping. */
export interface HeartbeatMsg {
  type: "heartbeat";
  ts: number;
}

/** Static-ish host inventory; refreshed on every (re)connect + periodically. */
export interface HostInfo {
  os: string; // platform, e.g. "ubuntu"
  osVersion: string; // e.g. "24.04"
  arch: string; // kernel arch, e.g. "x86_64"
  kernel: string; // kernel version
  cpuCores: number; // logical cores
  memTotalBytes: number; // total RAM in bytes
  bootTime: number; // unix seconds the host booted (uptime derived from this)
}

/** Agent -> Hub: host hardware/OS inventory. */
export interface HostInfoMsg {
  type: "host_info";
  info: HostInfo;
}

/** Hub -> Agent: run a shell command (bulk ops / exec). */
export interface CommandMsg {
  type: "command";
  reqId: string;
  command: string;
}

/** Agent -> Hub: result of a command. */
export interface CommandResultMsg {
  type: "command_result";
  reqId: string;
  exitCode: number;
  output: string;
}

export type AgentMessage =
  | EnrollMsg
  | AuthMsg
  | MetricsMsg
  | HeartbeatMsg
  | HostInfoMsg
  | CommandResultMsg;
export type HubMessage =
  | ChallengeMsg
  | EnrolledMsg
  | AuthOkMsg
  | ErrorMsg
  | CommandMsg;
