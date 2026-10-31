/**
 * @tugra/shared — types shared between the hub and the agent.
 * The agent (Go) mirrors these shapes (same JSON field names); keep them in sync.
 */

// Version — PROTOCOL_VERSION (re-exported so existing `import { PROTOCOL_VERSION } from "@tugra/shared"`
// consumers are unchanged) + the app/build metadata helpers (appVersion/versionInfo/…).
export * from "./version";

// Editions — the open-core tier ordering (community < pro < cloud) + normalizeEdition/editionAtLeast,
// shared by the hub's requireEdition gate and any web edition display.
export * from "./editions";

/**
 * Notification event types — single source of truth for the hub (Zod enum) and the web UI (served via
 * GET /channels/events). Every value here is subscribable AND reachable through `fireForEvent`. Add new
 * events here so backend validation and the UI never drift.
 *
 * NOTE: monitor up/down are intentionally NOT here — they fire via the MonitorChannel link
 * (`fireForMonitor`), not general channel subscription, so subscribing to them via `eventTypes` would
 * do nothing. A later slice routes them through `fireForEvent`; they will be re-added then.
 */
export const EVENT_TYPES = [
  "deploy_success",
  "deploy_failed",
  "deploy_rolled_back",
  "server_offline",
  "server_online",
  "swarm_degraded",
  "ssl_expiring",
  "token_expiring",
  "backup_failed",
  "backup_success",
  "backup_restore_failed",
  "volume_backup_success",
  "volume_backup_failed",
  "scheduled_task_success",
  "scheduled_task_failed",
  "docker_cleanup_success",
  "docker_cleanup_failed",
  "container_crashed",
  "container_oom",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/**
 * Granular resource permissions a team's custom role can grant. Built-in roles resolve to fixed
 * sets (OWNER/ADMIN → all of these; VIEWER → none). These cover RESOURCE actions only — member /
 * role / team administration stays reserved for the built-in OWNER/ADMIN roles (a custom role can
 * never grant the ability to manage members or roles, which would allow privilege escalation).
 */
export const TEAM_PERMISSIONS = [
  "apps:deploy", // deploy / rollback / restart / start / stop / preview / analyze / webhook
  "apps:config", // create / delete apps + all app config + scheduled tasks
  "databases", // database lifecycle + config
  "backups", // database backups + app volume backups
  "servers:manage", // server create/delete + tags / capabilities / network / enroll
  "servers:ops", // proxy / log drains / cleanup / patch
  "terminal", // interactive shell (remote code execution)
  "bulk", // fleet command execution (remote code execution)
  "monitors", // uptime / metric monitors
  "projects", // projects / environments / saved views
  "integrations", // git sources / registries / backup destinations / notification channels
  "variables", // team shared variables
] as const;
export type TeamPermission = (typeof TEAM_PERMISSIONS)[number];

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
/** Signed payload to cancel an in-flight command: just the reqId of the running command to kill. The agent
 *  verifies this (hub-origin proof) before killing that command's process group — the command was already
 *  capability-gated + signed when it started, so cancelling it needs no further grant. */
export function canonicalCommandCancel(reqId: string): string {
  return `ccancel\n${reqId}`;
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
export function canonicalLogStart(
  streamId: string,
  target: string,
  tail: number,
  follow: boolean,
  since: string,
  search: string,
  capability: string,
): string {
  return `logs\n${streamId}\n${target}\n${tail}\n${follow ? "1" : "0"}\n${since}\n${search}\n${capability}`;
}
/** Signed payload for a self-update command: the agent pulls `image` pinned to `sha256` and recreates
 *  itself. `capability` last binds the grant into the signature (anti-relabel), mirroring the others. */
export function canonicalAgentUpdate(
  reqId: string,
  targetVersion: string,
  image: string,
  sha256: string,
  capability: string,
): string {
  return `aupd\n${reqId}\n${targetVersion}\n${image}\n${sha256}\n${capability}`;
}
/** Signed payload for a file operation. `op` is the action (list/stat/read), `volume` the
 *  app volume key, `path` the volume-relative path. `capability` last binds the grant into the signature
 *  (anti-relabel), mirroring the others. The agent verifies this before launching the sandboxed fsd helper. */
export function canonicalFs(
  reqId: string,
  op: string,
  volume: string,
  path: string,
  capability: string,
): string {
  return `fs\n${reqId}\n${op}\n${volume}\n${path}\n${capability}`;
}

/** One entry in a file listing — metadata only, never content. A symlink is reported as "symlink" and is
 *  NEVER dereferenced. */
export interface FsEntry {
  name: string;
  type: "file" | "dir" | "symlink" | "other";
  size: number;
  mode: string; // rwx permission string, e.g. "rwxr-xr-x"
  mtime: number; // unix seconds
}
/** Hub -> Agent: a signed file operation (list/stat/read) scoped to one app volume. */
export interface FsReqMsg {
  type: "fs_req";
  reqId: string;
  op: "list";
  // The docker volume name the hub resolved from the app. MUST be a plain named volume matching
  // /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/ — the agent re-validates this (fsd.validateVolume) before it
  // becomes a `--mount src=` arg, so a host-path or mount-field injection can never escape to the host.
  volume: string;
  path: string; // volume-relative path
  capability?: AgentCapability;
  sig?: string;
}
/** Agent -> Hub: the result of an fs_req. */
export interface FsResultMsg {
  type: "fs_result";
  reqId: string;
  ok: boolean;
  error?: string;
  entries?: FsEntry[];
  truncated?: boolean; // true when the listing was capped at the agent's maxEntries limit
}

/**
 * Every capability the hub can grant a server (and the agent can locally allowlist). This is the SINGLE
 * SOURCE OF TRUTH: the hub's grantable set and the grant-API validation schema both derive from it, so a
 * new capability can never be added in one place and silently rejected by the other. "terminal", "swarm"
 * and "files" are opt-in (granted explicitly per server), never in a default grant.
 */
export const AGENT_CAPABILITIES = [
  "deploy",
  "database",
  "backup",
  "cleanup",
  "bulk",
  "terminal",
  "schedule",
  "patch",
  "logs",
  "swarm",
  "files", // read/list an app volume's files via the sandboxed fsd helper; default-off
] as const;

/** What a command is for — the agent can locally allowlist these. */
export type AgentCapability = (typeof AGENT_CAPABILITIES)[number];

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
  diskRead: number; // bytes/s (physical-disk read throughput)
  diskWrite: number; // bytes/s
  // Optional sensor metrics — absent when the host exposes none (most cloud VMs).
  temp?: number; // hottest CPU-ish sensor, °C
  sensors?: Record<string, number>; // per-sensor °C
  gpus?: GpuStat[];
  battery?: BatterySample | null;
}

/** One GPU's live usage (NVIDIA via nvidia-smi, AMD via sysfs). Mem is in bytes. */
export interface GpuStat {
  name: string;
  util: number; // 0..100 %
  memUsed: number; // bytes
  memTotal: number; // bytes
  temp?: number; // °C
  power?: number; // watts
}

/** System battery on laptop / UPS hosts; absent on servers and VMs. */
export interface BatterySample {
  percent: number; // 0..100
  state: string; // Charging | Discharging | Full | Not charging | Unknown
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
  /**
   * Optional machine-readable reason. "reenroll" is the ONLY authoritative signal that tells an
   * already-enrolled agent its stored identity is gone (server row deleted / never enrolled) and a
   * fresh enroll is the correct recovery. Absent on generic/transient rejections, which the agent must
   * treat as "keep the identity and retry" so a transient failure can never brick a valid agent.
   */
  code?: "reenroll";
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
  /** The reconnecting agent's version — refreshes the stored value (e.g. after a self-update). Optional
   *  for back-compat with older agents that don't send it. */
  agentVersion?: string;
}

/** Periodic host metrics. */
export interface MetricsMsg {
  type: "metrics";
  sample: MetricsSample;
}

/** Per-container resource usage from `docker stats`. netRx/netTx/blkRead/blkWrite are RATES (B/s)
 *  the agent derives from cumulative deltas; cpu/memPct are percentages, memUsed/memTotal bytes. */
export interface ContainerStat {
  id: string; // container id (changes on restart)
  name: string; // container name (stable key)
  cpu: number; // %
  memUsed: number; // bytes
  memTotal: number; // bytes
  memPct: number; // %
  netRx: number; // B/s
  netTx: number; // B/s
  blkRead: number; // B/s
  blkWrite: number; // B/s
}

/** Agent -> Hub: per-container metrics for every container on the host. */
export interface ContainerMetricsMsg {
  type: "container_metrics";
  ts: number; // unix ms the agent sampled
  samples: ContainerStat[];
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

// ── Live container-log follow (read-only, "logs" capability) ──
// A one-way stream: the hub starts a signed `docker logs --follow` session on the agent, the agent
// streams stdout/stderr lines back, and the hub relays them to an SSE client. Cancelable via log_stop
// (or agent disconnect). Narrower than "terminal" (no RCE) — only reads container logs.

/** Hub -> Agent: start following a container's logs. target is a resolved container name. */
export interface LogStartMsg {
  type: "log_start";
  streamId: string;
  target: string;
  tail: number;
  follow: boolean;
  since?: string; // docker --since window (e.g. "5m", "1h"); "" = from the tail
  search?: string; // server-side grep -iF filter; "" = no filter
  /** Swarm apps: target is a `docker service` name → follow `docker service logs` (aggregated across
   *  replicas). NOT part of canonicalLogStart (target is already signed; this only toggles the subcommand). */
  service?: boolean;
  capability?: "logs";
  /** base64(ed25519 signature over canonicalLogStart) — agent rejects if invalid. */
  sig?: string;
}

/** Hub -> Agent: stop a log stream (client SSE closed). */
export interface LogStopMsg {
  type: "log_stop";
  streamId: string;
}

/** Agent -> Hub: a line (or block) of a log stream's output. */
export interface LogChunkMsg {
  type: "log_chunk";
  streamId: string;
  chunk: string;
}

/** Agent -> Hub: a log stream ended (process exited or was cancelled). */
export interface LogExitMsg {
  type: "log_exit";
  streamId: string;
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

/** Hub -> Agent: update yourself. The agent pulls `image` pinned to `sha256` (the per-arch image-manifest
 *  digest from the signed release manifest — Docker enforces it), then recreates its own container on the
 *  new image. `image`/`targetVersion`/`sha256` come ONLY from the hub's verified manifest, never a caller. */
export interface AgentUpdateMsg {
  type: "agent_update";
  reqId: string;
  targetVersion: string;
  image: string; // full ref, e.g. ghcr.io/simeraycom/tugra-agent:0.2.0
  sha256: string; // per-arch image-manifest digest (bare lowercase hex)
  capability?: AgentCapability;
  /** base64(ed25519 signature over canonicalAgentUpdate) — agent rejects if invalid. */
  sig?: string;
}

/** Agent -> Hub: a pre-handoff self-update outcome. Success is signalled IMPLICITLY by the recreated
 *  agent reconnecting with a new agentVersion; this only reports early failures (validate/pull/helper). */
export interface AgentUpdateResultMsg {
  type: "agent_update_result";
  reqId: string;
  targetVersion: string;
  ok: boolean;
  phase: string; // "noop" | "pull" | "helper" | "applying" | "validate"
  error?: string;
}

export type AgentMessage =
  | EnrollMsg
  | AuthMsg
  | MetricsMsg
  | ContainerMetricsMsg
  | HeartbeatMsg
  | HostInfoMsg
  | CommandLogMsg
  | CommandResultMsg
  | AgentUpdateResultMsg
  | TermOutputMsg
  | TermExitMsg
  | LogChunkMsg
  | LogExitMsg
  | FsResultMsg;
export type HubMessage =
  | ChallengeMsg
  | EnrolledMsg
  | AuthOkMsg
  | ErrorMsg
  | CommandMsg
  | AgentUpdateMsg
  | TermStartMsg
  | TermInputMsg
  | TermResizeMsg
  | TermCloseMsg
  | LogStartMsg
  | LogStopMsg
  | LogDrainsMsg
  | CapabilitiesMsg
  | FsReqMsg;
