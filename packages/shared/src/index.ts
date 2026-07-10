/**
 * @tugra/shared — types shared between the hub and the agent.
 * The agent (Go) mirrors these shapes (same JSON field names); keep them in sync.
 */

export const PROTOCOL_VERSION = 2;

/**
 * Notification event types — single source of truth for the hub (Zod enum) and
 * the web UI. Add new events here so backend validation and the UI never drift.
 */
export const EVENT_TYPES = [
  "deploy_success",
  "deploy_failed",
  "deploy_rolled_back",
  "server_offline",
  "monitor_down",
  "monitor_up",
  "ssl_expiring",
  "token_expiring",
  "backup_failed",
  "backup_restore_failed",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/**
 * Canonical strings the hub signs (ed25519) and the agent verifies. Fixed,
 * delimited format (NOT JSON) so TS and Go produce byte-identical input.
 * The Go agent mirrors these exactly.
 */
export function canonicalCommand(
  reqId: string,
  command: string,
  timeoutMs: number,
  capability: string,
): string {
  return `cmd\n${reqId}\n${command}\n${timeoutMs}\n${capability}`;
}
export function canonicalTermStart(
  sessionId: string,
  target: string,
  cols: number,
  rows: number,
  capability: string,
): string {
  return `term\n${sessionId}\n${target}\n${cols}\n${rows}\n${capability}`;
}

/** What a command is for — the agent can locally allowlist these. */
export type AgentCapability =
  | "deploy"
  | "database"
  | "backup"
  | "cleanup"
  | "bulk"
  | "terminal"
  | "schedule"
  | "patch";

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
  /** Hub's ed25519 public key (base64 SPKI) — agent pins it to verify command signatures. */
  hubKey?: string;
  /** The capabilities the hub grants this server — the agent enforces them fail-closed (empty = deny). */
  capabilities?: AgentCapability[];
}

/** Re-auth (reconnect) accepted. */
export interface AuthOkMsg {
  type: "auth_ok";
  serverId: string;
  hubKey?: string;
  /** Granted capabilities (re-pushed on every reconnect). */
  capabilities?: AgentCapability[];
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
  reportedIps?: string[]; // non-virtual, non-loopback interface IPs (reconciled with the observed IP)
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
  /** Per-command timeout in ms. When omitted the agent uses its default. */
  timeoutMs?: number;
  /** What this command is for — the agent may locally allowlist capabilities. */
  capability?: AgentCapability;
  /** base64(ed25519 signature over canonicalCommand) — agent rejects if invalid. */
  sig?: string;
}

/** Agent -> Hub: a chunk of a running command's combined stdout+stderr. */
export interface CommandLogMsg {
  type: "command_log";
  reqId: string;
  chunk: string;
}

/** Agent -> Hub: result of a command. */
export interface CommandResultMsg {
  type: "command_result";
  reqId: string;
  exitCode: number;
  output: string;
}

// ── Interactive terminal (web shell) ──
// data fields are base64-encoded raw TTY bytes (binary-safe over JSON).

/** Hub -> Agent: open a PTY. target="" → host `sh`; else a container name. */
export interface TermStartMsg {
  type: "term_start";
  sessionId: string;
  target: string;
  cols: number;
  rows: number;
  capability?: "terminal";
  /** base64(ed25519 signature over canonicalTermStart) — agent rejects if invalid. */
  sig?: string;
}

/** Hub -> Agent: stdin for a session (base64). */
export interface TermInputMsg {
  type: "term_input";
  sessionId: string;
  data: string;
}

/** Hub -> Agent: resize a session's PTY. */
export interface TermResizeMsg {
  type: "term_resize";
  sessionId: string;
  cols: number;
  rows: number;
}

/** Hub -> Agent: close a session. */
export interface TermCloseMsg {
  type: "term_close";
  sessionId: string;
}

/** Agent -> Hub: a chunk of a session's PTY output (base64). */
export interface TermOutputMsg {
  type: "term_output";
  sessionId: string;
  data: string;
}

/** Agent -> Hub: a session ended. */
export interface TermExitMsg {
  type: "term_exit";
  sessionId: string;
  exitCode: number;
}

/** Hub -> Agent: the server's active log drains (container logs are forwarded here). */
export interface LogDrainCfg {
  id: string;
  endpoint: string;
  token?: string;
}
export interface LogDrainsMsg {
  type: "log_drains";
  drains: LogDrainCfg[];
}

/** Pushed when a server's granted capabilities change, so a connected agent updates its
 *  fail-closed allowlist live (no re-enrollment needed). */
export interface CapabilitiesMsg {
  type: "capabilities";
  capabilities: AgentCapability[];
}

export type AgentMessage =
  | EnrollMsg
  | AuthMsg
  | MetricsMsg
  | HeartbeatMsg
  | HostInfoMsg
  | CommandLogMsg
  | CommandResultMsg
  | TermOutputMsg
  | TermExitMsg;
export type HubMessage =
  | ChallengeMsg
  | EnrolledMsg
  | AuthOkMsg
  | ErrorMsg
  | CommandMsg
  | TermStartMsg
  | TermInputMsg
  | TermResizeMsg
  | TermCloseMsg
  | LogDrainsMsg
  | CapabilitiesMsg;
