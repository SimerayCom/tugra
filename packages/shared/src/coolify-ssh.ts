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
  // Hub-side outcomes of an install whose result the hub could not trust: our agent was found afterwards / nothing could be confirmed.
  "agent_left_behind", "install_unconfirmed",
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

/**
 * Hub -> Agent: probe, install or remove the Tugra agent on ONE Coolify-known server. The agent resolves the address itself from
 * Coolify's own `servers` table; the hub only names the Coolify server uuid.
 *
 * Signed fields (see canonicalCoolifySsh): reqId, op, coolifyServerUuid, scriptSha256, payloadSha256, useSudo, expectedHostKeyFp, exp,
 * capability. `payload` and `script` are NOT signed themselves but are bound by their sha256, so a swapped body fails the check:
 *  - probe: no payload, no script. The agent runs the probe script it embeds and checks its hash against `scriptSha256`.
 *  - install: `payload` is the enroll token (it travels on the script's stdin only, never in an argument), `script` is the installer body.
 *  - uninstall: `payload` is the container id this run installed (the script refuses any other container); the agent embeds the script.
 */
export interface CoolifySshReqMsg {
  type: "coolify_ssh_req";
  reqId: string;
  op: CoolifySshOp;
  coolifyServerUuid: string;
  /** sha256 hex of the script that runs. probe/uninstall: must equal the hash of the script the agent embeds. */
  scriptSha256: string;
  /** sha256 hex of `payload` ("" hashes to the empty-string digest). */
  payloadSha256: string;
  /** Run the script with `sudo -n` on the target (the hub decided from a READY probe). */
  useSudo: boolean;
  /** The host key fingerprint the probe saw ("" on the first probe). The agent refuses a different one before anything is sent. */
  expectedHostKeyFp: string;
  exp: number; // unix seconds
  capability: "coolify_ssh";
  sig?: string;
  /** install only: the installer body (hash-bound by scriptSha256). */
  script?: string;
  /** install: the enroll token; uninstall: the container id. Hash-bound by payloadSha256. */
  payload?: string;
}

export interface CoolifySshFields {
  reqId: string;
  op: CoolifySshOp;
  coolifyServerUuid: string;
  scriptSha256: string;
  payloadSha256: string;
  useSudo: boolean;
  expectedHostKeyFp: string;
  exp: number;
  capability: string;
}

declare const TextEncoder: new () => { encode(input: string): { length: number } };
const SSH_ENC = new TextEncoder();
function sshField(v: string | number): string {
  const s = String(v);
  return `${SSH_ENC.encode(s).length}:${s}`;
}

/**
 * The signed text of a coolify_ssh_req: "cssh\n" + the nine fields in the order of CoolifySshFields, each `<utf8ByteLength>:<value>`,
 * joined by "\n" (the fs2 form: an embedded newline can never forge or shift a field). Must stay byte-identical to the Go
 * `protocol.CanonicalCoolifySSH`.
 */
export function canonicalCoolifySsh(f: CoolifySshFields): string {
  return (
    "cssh\n" +
    [f.reqId, f.op, f.coolifyServerUuid, f.scriptSha256, f.payloadSha256, f.useSudo ? "1" : "0", f.expectedHostKeyFp, f.exp, f.capability].map(sshField).join("\n")
  );
}

/** A Coolify server uuid as the agent accepts it (lower-case alphanumerics, as Coolify's cuid-style ids are). */
export const COOLIFY_SSH_UUID_RE = /^[a-z0-9]{6,64}$/;
/** A container id the uninstall pins itself to. */
export const COOLIFY_SSH_CONTAINER_ID_RE = /^[0-9a-f]{64}$/;
/** The enroll token shape the installer takes on stdin. */
export const COOLIFY_SSH_TOKEN_RE = /^tugra_en_[A-Za-z0-9_-]{16,128}$/;
/** SHA256:<base64> as ssh-keygen prints a host key fingerprint ("" = not known yet). */
export const COOLIFY_SSH_HOSTKEY_FP_RE = /^(SHA256:[A-Za-z0-9+/]{43})?$/;

/** Codes after which the owner is shown the manual install command as the way forward (the others are decisions or already final). */
export const COOLIFY_SSH_MANUAL_FALLBACK_CODES: readonly CoolifySshResultCode[] = [
  "unreachable", "auth_failed", "no_key_file", "needs_root", "sudo_tty", "docker_missing", "docker_perm", "pull_failed",
  "hub_unreachable_from_target", "installer_failed", "enroll_timeout", "unsupported_proxy", "timeout", "bad_target", "arch_unsupported",
];
export function coolifySshOffersManualCommand(code: CoolifySshResultCode | null): boolean {
  return code !== null && COOLIFY_SSH_MANUAL_FALLBACK_CODES.includes(code);
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
  /** The host key fingerprint the AGENT on the Coolify host saw on the wire (never a value the target reported about itself). */
  sshHostKeyFp?: string;
  /** True when Coolify itself pinned that key (server_settings), false when it was trusted on first use. */
  hostKeyPinned?: boolean;
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
  /** install: the id of the container this run started (the later uninstall is pinned to it). */
  containerId?: string;
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
  /** The owner is shown the manual command after this failure. */
  manualCommand: boolean;
  /** This run installed the agent and it can be taken off again with one click. */
  canRemove: boolean;
  /** The probe's findings, as facts only. */
  probe: CoolifyProbeFacts | null;
  updatedAt: string;
}

/** One install run: its targets and the consent window it runs under. */
export interface CoolifySshRunView {
  runId: string;
  inventoryServerId: string;
  teamId: string;
  expiresAt: string;
  /** No target is waiting for the hub any more. */
  finished: boolean;
  targets: CoolifySshTargetView[];
}

/** Owner-only body of "install the agent on these N servers": `confirm` is the typed count. */
export interface CoolifySshInstallRequest {
  inventoryServerId: string;
  coolifyServerUuids: string[];
  teamId: string;
  confirm: string;
}
