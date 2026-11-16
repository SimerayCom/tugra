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
export * from "./app-move";
export * from "./import-reasons";
// Client-IP trust (X-Forwarded-For / Cloudflare) — shared by the hub and the web server. Node-only (node:net).
export * from "./client-ip";
export * from "./cloudflare-ips";

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
  "backup_missing",
  "backup_recovered",
  "backup_restore_failed",
  "verify_missing",
  "verify_recovered",
  "volume_backup_success",
  "volume_backup_failed",
  "scheduled_task_success",
  "scheduled_task_failed",
  "docker_cleanup_success",
  "docker_cleanup_failed",
  "container_crashed",
  "container_oom",
  "container_unhealthy",
  "container_mem_pressure",
  "rollout_halted",
  "rollout_completed",
  "rollout_rolled_back",
  "rollout_rollback_failed",
  "image_update_available",
  "app_move_completed",
  "app_move_rolled_back",
  "app_move_failed",
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
/** Signed payload to ask an agent what happened to a (durable) command by reqId. Read-only: the agent answers
 *  from its on-disk command journal (running / done + result / interrupted / unknown) and never re-runs
 *  anything. Lets a restarted hub recover the outcome of a deploy it dispatched before it died. */
export function canonicalCommandStatus(reqId: string): string {
  return `cstat\n${reqId}`;
}

/**
 * Optional per-feature capabilities an agent advertises in enroll/auth (`features`). Additive and independent of
 * PROTOCOL_VERSION: an old agent sends none and the hub falls back to the legacy behaviour per feature.
 *
 * - `cmd_journal_v1`: the agent journals `durable` commands on disk (begin/finish/exit/output tail), keeps them
 *   running across a WebSocket drop, de-duplicates a re-sent reqId (never re-runs it), and answers
 *   `command_status` with `command_state`. Deploys dispatched to such an agent can be adopted after a hub restart.
 */
export const AGENT_FEATURE_CMD_JOURNAL = "cmd_journal_v1";
/** `log_drains_v2`: the agent accepts the signed, `logs`-capability-gated `log_drains_v2` frame (per-app scope,
 *  container match, per-transport options, egress policy) and reports `drain_status`. */
export const AGENT_FEATURE_LOG_DRAINS_V2 = "log_drains_v2";
/** Per-transport features: a drain of that type is only sent to an agent advertising the matching flag. */
export const AGENT_FEATURE_DRAIN_SYSLOG = "log_drain_syslog_v1";
export const AGENT_FEATURE_DRAIN_GELF = "log_drain_gelf_v1";
export const AGENT_FEATURE_DRAIN_FLUENTD = "log_drain_fluentd_v1";
/** Signed payload of a `log_drains_v2` frame. Byte-identical to the Go agent's CanonicalLogDrains. */
export function canonicalLogDrains(serverId: string, rev: number, drainsJson: string, capability: string): string {
  return `ldrn\n${serverId}\n${rev}\n${drainsJson}\n${capability}`;
}
/**
 * `fs2_v1`: the agent understands the signed `fs2_req` file protocol (write-capable volume ops, container
 * filesystem ops, bounded transfers). The hub refuses to send `fs2_req` to an agent without it (409 `agent_too_old`).
 * The legacy `fs_req` list path is unaffected.
 */
export const AGENT_FEATURE_FS2 = "fs2_v1";
/**
 * `hub_origin_env_v1`: the agent exports `TUGRA_HUB_ORIGIN` (derived from its OWN configured hub URL) to commands
 * of the `backup` capability only, so a hub-built script can pull/push a signed relay path without the hub ever
 * naming a host. The app-move preflight refuses a server whose agent lacks it (`agent_too_old`).
 */
export const AGENT_FEATURE_HUB_ORIGIN_ENV = "hub_origin_env_v1";
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

/** Where an fs2 op runs: a declared app volume (sandboxed helper) or the live container filesystem. */
export type Fs2Scope = "volume" | "container";
/** `list` is container-scope only (volume listing stays on the legacy fs_req path). */
export type Fs2Op = "list" | "stat" | "read" | "write" | "mkdir" | "rename" | "chmod" | "delete";
export const FS2_MUTATING_OPS: readonly Fs2Op[] = ["write", "mkdir", "rename", "chmod", "delete"];
/** Closed set of machine-readable file-op failure codes (agent -> hub -> HTTP -> UI). */
export const FS_ERROR_CODES = [
  "not_found",
  "exists",
  "not_dir",
  "is_dir",
  "not_regular",
  "not_empty",
  "denied",
  "read_only",
  "no_space",
  "too_large",
  "changed",
  "integrity",
  "bad_request",
  "unsupported",
  "not_configured",
  "busy",
  "expired",
  "not_running",
  "no_binary",
  "failed",
] as const;
export type FsErrorCode = (typeof FS_ERROR_CODES)[number];

/** Every signed field of an fs2_req, in canonical order (see canonicalFs2). */
export interface Fs2Fields {
  reqId: string;
  op: Fs2Op;
  scope: Fs2Scope;
  /** docker volume name (scope volume) | container name (scope container) */
  subject: string;
  path: string;
  path2: string;
  /** "" | ^[0-7]{3,4}$ (octal permission bits, never setuid/setgid/sticky) */
  mode: string;
  /** sorted-unique subset of "o" (overwrite) "r" (recursive) "p" (parents) */
  flags: string;
  size: number;
  sha256: string;
  /** "" | "<size>-<mtimeNs>" optimistic-concurrency token */
  ifMatch: string;
  /** "" | relative hub transfer path the agent GETs from (write) or PUTs to (read) */
  xfer: string;
  timeoutMs: number;
  /** unix seconds; the agent rejects a request past it */
  exp: number;
  capability: string;
}

// This package compiles without DOM/node typings (lib ES2022) yet runs in node and the browser, where
// TextEncoder is a global. Declare only the slice we use (module-scoped, so it never clashes with a consumer's lib).
declare const TextEncoder: new () => { encode(input: string): { length: number } };
const FS2_ENC = new TextEncoder();
function fs2Field(v: string | number): string {
  const s = String(v);
  return `${FS2_ENC.encode(s).length}:${s}`;
}
/**
 * Signed payload for an fs2 file operation: "fs2\n" + the 15 fields in EXACT interface order, each rendered as
 * `<utf8ByteLength>:<value>` and joined by "\n". Length-prefixing means a value containing a newline can never
 * forge or shift another field (no reliance on rejecting bytes). `capability` is last and binds the grant into
 * the signature. Must stay byte-identical to the Go `protocol.CanonicalFs2`.
 */
export function canonicalFs2(f: Fs2Fields): string {
  return (
    "fs2\n" +
    [
      f.reqId, f.op, f.scope, f.subject, f.path, f.path2, f.mode, f.flags,
      f.size, f.sha256, f.ifMatch, f.xfer, f.timeoutMs, f.exp, f.capability,
    ]
      .map(fs2Field)
      .join("\n")
  );
}

/**
 * The capability SET an fs2 op needs, in order; the LAST element is the signed `capability`. Both the hub
 * (before sending) and the agent (before running) enforce every element. Unknown (scope, op) => [].
 *   volume    stat, read                              [files]
 *   volume    write, mkdir, rename, chmod, delete     [files, files_write]
 *   container list, stat, read                        [files, terminal]
 *   container write, mkdir, rename, chmod, delete     [files, files_write, terminal]
 */
export function fs2RequiredCapabilities(scope: Fs2Scope, op: Fs2Op): AgentCapability[] {
  const mutating = FS2_MUTATING_OPS.includes(op);
  if (scope === "volume") {
    if (op === "stat" || op === "read") return ["files"];
    return mutating ? ["files", "files_write"] : [];
  }
  if (scope === "container") {
    if (op === "list" || op === "stat" || op === "read") return ["files", "terminal"];
    return mutating ? ["files", "files_write", "terminal"] : [];
  }
  return [];
}

/** Hub -> Agent: a signed fs2 file operation. */
export interface Fs2ReqMsg extends Fs2Fields {
  type: "fs2_req";
  sig?: string;
}
/** stat of one filesystem object (never dereferences a symlink). */
export interface Fs2Stat {
  name: string;
  type: "file" | "dir" | "symlink" | "other";
  size: number;
  mode: string; // octal permission bits, e.g. "0644"
  mtime: number; // unix seconds
  mtimeNs: number;
  uid: number;
  gid: number;
  etag: string; // "<size>-<mtimeNs>"
  linkTarget?: string;
  uname?: string;
  gname?: string;
}
/** Agent -> Hub: the result of an fs2_req. */
export interface Fs2ResultMsg {
  type: "fs2_result";
  reqId: string;
  ok: boolean;
  code?: FsErrorCode;
  error?: string;
  stat?: Fs2Stat;
  entries?: FsEntry[];
  truncated?: boolean;
  bytes?: number;
  sha256?: string;
  etag?: string;
  created?: boolean;
}

/**
 * Every capability the hub can grant a server (and the agent can locally allowlist). This is the SINGLE
 * SOURCE OF TRUTH: the hub's grantable set and the grant-API validation schema both derive from it, so a
 * new capability can never be added in one place and silently rejected by the other. "terminal", "swarm",
 * "files" and "files_write" are opt-in (granted explicitly per server), never in a default grant.
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
  "files", // read/list/stat/download an app volume's files via the sandboxed fsd helper; default-off
  "files_write", // opt-in, requires "files": upload/create/edit/rename/chmod/delete (volume write profile); never default
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
  // Optional load average + swap — absent from older agents / hosts that can't report them.
  load1?: number;
  load5?: number;
  load15?: number;
  swapUsed?: number; // bytes
  swapTotal?: number; // bytes (0/absent = no swap)
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
   * fresh enroll is the correct recovery. "agent_incompatible" means the hub rejected this agent's
   * protocol/version — the agent must KEEP its identity, update, and retry (it is NOT a reenroll signal).
   * Absent on generic/transient rejections, which the agent must likewise treat as "keep the identity and
   * retry" so a transient failure can never brick a valid agent.
   */
  code?: "reenroll" | "agent_incompatible";
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
  /** Optional feature flags (see AGENT_FEATURE_*). Absent on older agents. */
  features?: string[];
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
  /** Optional feature flags (see AGENT_FEATURE_*). Absent on older agents. */
  features?: string[];
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

/**
 * Fixed latency histogram bucket upper bounds in MILLISECONDS (inclusive). A request of d ms lands in the
 * first bucket with d <= bound; the extra last count is the overflow (> 10000 ms), so a `latency` array has
 * TRAFFIC_LATENCY_BUCKETS_MS.length + 1 = 14 counts. The hub recovers p95 by cumulative interpolation.
 * Mirrored in agent/internal/protocol (TrafficLatencyBucketsMs).
 */
export const TRAFFIC_LATENCY_BUCKETS_MS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000] as const;

/** A dimension value and its request count (already capped; the remainder is folded into "(other)"). */
export interface TrafficKeyCount {
  k: string;
  n: number;
}

/**
 * One host's per-minute request aggregate (counts only). Every dimension below is computed LOCALLY by the
 * agent; no raw client IP, User-Agent string, Referer URL or cookie is ever carried.
 */
export interface TrafficDomainStat {
  host: string; // request Host header (lowercased by the hub on ingest)
  requests: number;
  s2xx: number;
  s3xx: number;
  s4xx: number;
  s5xx: number;
  bytes: number; // response bytes
  paths: { p: string; n: number; b: number }[]; // top paths: path, requests, bytes
  countries?: { c: string; n: number }[]; // ISO-3166 alpha-2 country code, requests ("ZZ" = unknown/overflow)
  browsers?: TrafficKeyCount[]; // browser family name ("Chrome", "Firefox", ...)
  os?: TrafficKeyCount[]; // OS name ("Windows", "iOS", ...)
  devices?: TrafficKeyCount[]; // device class: desktop | mobile | tablet | bot | other
  referrers?: TrafficKeyCount[]; // referrer HOST only ("(direct)" = none / same host)
  cities?: TrafficKeyCount[]; // city name from the local GeoIP City DB (omitted when IP mode is off)
  networks?: TrafficKeyCount[]; // ANONYMIZED network: IPv4 /24 ("1.2.3.0/24") or IPv6 /48 (omitted when IP mode is off)
  bots?: { human: number; bot: number };
  latency?: number[]; // counts per TRAFFIC_LATENCY_BUCKETS_MS bucket + overflow (length 14)
  // Unique visitors: base64 of a 4096-byte HyperLogLog register array (p=12, one byte per register; precision,
  // hash and estimator are specified in agent/internal/traffic/hll.go and apps/hub-api/src/traffic/hll.ts).
  // Registers only - never a client IP. Omitted/empty when no visitor was countable; the hub merges per minute.
  unique?: string;
}

/**
 * Agent -> Hub: pre-aggregated visitor traffic for one window (typically 60s). The hub sums into per-minute
 * rows (additive, not idempotent), so windows must be disjoint and each reported at most once: the agent
 * must never replay a window after a reconnect.
 */
export interface TrafficMetricsMsg {
  type: "traffic_metrics";
  ts: number; // unix ms the window ended
  windowSec: number;
  domains: TrafficDomainStat[];
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
  /** Journal this command on the agent (cmd_journal_v1): it survives a WebSocket drop, a re-sent reqId is never
   *  re-run, and `command_status` can recover its outcome later. NOT part of canonicalCommand (like
   *  LogStartMsg.service): the signed reqId/command/timeout/capability are unchanged, and an old agent simply
   *  ignores the flag and runs the command exactly as before. */
  durable?: boolean;
}

/** Hub -> Agent: what happened to command `reqId`? (cmd_journal_v1; signed with canonicalCommandStatus). The
 *  agent never re-runs anything in response — it only reports from its journal. */
export interface CommandStatusMsg {
  type: "command_status";
  reqId: string;
  /** base64(ed25519 signature over canonicalCommandStatus) — agent rejects if invalid. */
  sig?: string;
}

/** Agent -> Hub: reply to command_status. `running` = still executing on this agent (its command_result will
 *  follow on this connection); `done` = finished, exitCode/output carry the journaled result; `interrupted` = the
 *  agent process itself restarted while the command ran, so the outcome is unknown; `unknown` = no journal
 *  entry (never received, or pruned). `killed` = the process group was killed by a command_cancel. */
export interface CommandStateMsg {
  type: "command_state";
  reqId: string;
  state: "running" | "done" | "interrupted" | "unknown";
  exitCode?: number;
  /** Journaled combined output (head + tail of the stream; the end is kept so trailing markers survive). */
  output?: string;
  killed?: boolean;
  startedAt?: number; // unix ms
  finishedAt?: number; // unix ms
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

/** Hub -> Agent (D7, agents advertising `log_drains_v2`): the FULL set of log drains for the server, as a
 *  pre-serialised JSON STRING (`drainsJson`) so the signature covers the exact bytes (no TS/Go canonical-JSON
 *  divergence). Signed with canonicalLogDrains and gated on the `logs` capability. The serverId in the signature
 *  stops a frame captured for server A being replayed to server B (the hub key is fleet-wide). */
export interface LogDrainsV2Msg {
  type: "log_drains_v2";
  serverId: string;
  rev: number;
  capability: "logs";
  drainsJson: string;
  /** base64(ed25519 signature over canonicalLogDrains) — agent rejects if invalid. */
  sig?: string;
}

/** Legacy Hub -> Agent drain push (unsigned, ungated): ONLY plain server-wide http/loki/datadog drains, sent to
 *  agents without `log_drains_v2`. Byte-identical to the pre-D7 frame. */
export interface LogDrainCfg {
  id: string;
  type: string;
  endpoint: string;
  token: string;
}
export interface LogDrainsMsg {
  type: "log_drains";
  drains: LogDrainCfg[];
}

/** Error class of a failing drain sink: an enum only, never raw error text (no endpoint/token can leak). */
export type DrainErrClass =
  | "dns"
  | "dial"
  | "tls"
  | "timeout"
  | "refused"
  | "http"
  | "write"
  | "ack"
  | "policy"
  | "config"
  | "auth"
  | "overflow";
export const DRAIN_ERR_CLASSES: readonly DrainErrClass[] = [
  "dns", "dial", "tls", "timeout", "refused", "http", "write", "ack", "policy", "config", "auth", "overflow",
];
export const DRAIN_STATES = ["ok", "error", "idle", "invalid"] as const;
export interface DrainStatusEntry {
  id: string;
  state: (typeof DRAIN_STATES)[number];
  errClass?: DrainErrClass;
  sent: number;
  dropped: number;
  /** Lines delivered but cut to the transport's size cap (syslog); omitted when zero. */
  truncated?: number;
  lastOkAt?: number;
}
/** Agent -> Hub: per-sink delivery status (in-memory on the hub; no error text, only the enum class). */
export interface DrainStatusMsg {
  type: "drain_status";
  drains: DrainStatusEntry[];
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
  | TrafficMetricsMsg
  | HeartbeatMsg
  | HostInfoMsg
  | CommandLogMsg
  | CommandResultMsg
  | AgentUpdateResultMsg
  | TermOutputMsg
  | TermExitMsg
  | LogChunkMsg
  | LogExitMsg
  | FsResultMsg
  | Fs2ResultMsg
  | CommandStateMsg
  | DrainStatusMsg;
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
  | LogDrainsV2Msg
  | CapabilitiesMsg
  | FsReqMsg
  | Fs2ReqMsg
  | CommandStatusMsg;
