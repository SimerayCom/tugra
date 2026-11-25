/**
 * Coolify hub takeover, lane C (install the Tugra agent on the Coolify servers over Coolify's own SSH keys): the shared
 * vocabulary. Types and constants only; no behaviour. The key never leaves the Coolify host and the hub never sees it.
 * Lane C owns this file. Other lanes only import from it.
 */

export const COOLIFY_SSH_OPS = ["probe", "install", "uninstall"] as const;
export type CoolifySshOp = (typeof COOLIFY_SSH_OPS)[number];

/** Fixed result codes (the hub maps each to an i18n line and a manual-command fallback). */
export const COOLIFY_SSH_RESULT_CODES = [
  "ok_installed", "skipped_present", "skipped_foreign", "unreachable", "auth_failed", "hostkey_changed", "hostkey_mismatch", "no_key_file",
  "bad_target", "needs_root", "sudo_tty", "docker_missing", "docker_perm", "arch_unsupported", "pull_failed", "hub_unreachable_from_target",
  "installer_failed", "enroll_timeout", "unsupported_proxy", "cancelled", "timeout",
] as const;
export type CoolifySshResultCode = (typeof COOLIFY_SSH_RESULT_CODES)[number];

export const COOLIFY_SSH_TARGET_STATES = [
  "PLANNED", "PROBING", "SKIPPED_PRESENT", "SKIPPED_FOREIGN", "READY", "FAILED", "TOKEN_MINTED", "INSTALLING", "WAIT_ENROLL", "ONLINE", "UNINSTALLING", "REMOVED",
] as const;
export type CoolifySshTargetState = (typeof COOLIFY_SSH_TARGET_STATES)[number];
/** States a target does not leave on its own. */
export const COOLIFY_SSH_TERMINAL_STATES: readonly CoolifySshTargetState[] = ["SKIPPED_PRESENT", "SKIPPED_FOREIGN", "FAILED", "ONLINE", "REMOVED"];

/** What a probe found about an existing Tugra agent on the target. */
export type CoolifySshAgentPresence = "none" | "ours" | "foreign_hub" | "stopped";

/** Concurrency and time limits (defaults; the host setting may move the per-host value inside 1..8). */
export const COOLIFY_SSH_LIMITS = {
  perHostDefault: 4,
  perHostMax: 8,
  perHub: 8,
  jitterMaxMs: 2000,
  targetTimeoutMs: 8 * 60_000,
  runTimeoutMs: 45 * 60_000,
  tokenTtlMs: 60 * 60_000,
} as const;

/** Hub -> Agent: probe, install or remove the Tugra agent on ONE Coolify-known server. The agent resolves the address itself. */
export interface CoolifySshReqMsg {
  type: "coolify_ssh_req";
  reqId: string;
  op: CoolifySshOp;
  coolifyServerUuid: string;
  scriptSha256: string;
  payloadSha256: string;
  exp: number; // unix seconds
  capability: "coolify_ssh";
  sig?: string;
}

/** The facts a probe reports (all parsed from `TUGRA_PROBE` lines; a truncated reply is "unknown", never "absent"). */
export interface CoolifyProbeFacts {
  uid?: number;
  dockerAccess?: boolean;
  sudoNoPassword?: boolean;
  arch?: string;
  agent?: CoolifySshAgentPresence;
  diskFreeMb?: number;
  hubReachable?: boolean;
  sshHostKeyFp?: string;
  machineIdHash?: string;
  dockerEngineId?: string;
}

/** Agent -> Hub: the outcome of one request. Fixed codes only; never a command line or a key path. */
export interface CoolifySshResultMsg {
  type: "coolify_ssh_result";
  reqId: string;
  ok: boolean;
  code: CoolifySshResultCode;
  probe?: CoolifyProbeFacts;
  durationMs?: number;
}

/** One target row as the API returns it. Names and states; never an address of a key, never a token. */
export interface CoolifySshTargetView {
  id: string;
  runId: string;
  coolifyServerUuid: string;
  name: string;
  state: CoolifySshTargetState;
  code: CoolifySshResultCode | null;
  tugraServerId: string | null;
  updatedAt: string;
}

/** Owner-only body of "install the agent on these N servers": `confirm` is the typed count. */
export interface CoolifySshInstallRequest {
  inventoryServerId: string;
  coolifyServerUuids: string[];
  teamId: string;
  confirm: string;
}
