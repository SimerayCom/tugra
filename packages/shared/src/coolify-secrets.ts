/**
 * Coolify hub takeover, lane B (sealed secret pipeline): the shared vocabulary. Types and constants only; no behaviour.
 * The agent reads Coolify's own database on its host, decrypts values there and seals each one to a per-run X25519 key
 * (envelope "tse1"); the hub opens it in one function. Plaintext never rides the wire, a log or an audit row.
 * Lane B owns this file. Other lanes only import from it.
 */

/** What an agent may be asked to read: the `kind` half of a `kind:uuid` ref. */
export const COOLIFY_SECRET_REF_KINDS = ["env", "shared_env", "database", "service", "application", "scheduled_task", "s3", "notification", "git_app", "private_key"] as const;
export type CoolifySecretRefKind = (typeof COOLIFY_SECRET_REF_KINDS)[number];

/** The consent classes. T1 are on by default; T2 need an explicit opt-in. T0 (APP_KEY, Coolify's own passwords, SSH private keys) is never readable. */
export const COOLIFY_SECRET_CLASSES = ["env", "shared_env", "db_credentials", "basic_auth", "service_compose", "task_command", "s3", "notification", "git_app_key", "deploy_key"] as const;
export type CoolifySecretClass = (typeof COOLIFY_SECRET_CLASSES)[number];
export type CoolifySecretTier = "T1" | "T2";
export const COOLIFY_SECRET_TIER: Readonly<Record<CoolifySecretClass, CoolifySecretTier>> = {
  env: "T1",
  shared_env: "T1",
  db_credentials: "T1",
  basic_auth: "T1",
  service_compose: "T1",
  task_command: "T1",
  s3: "T1",
  notification: "T2",
  git_app_key: "T2",
  deploy_key: "T2",
};

/** Fixed codes the agent puts on the wire for one value it could not hand over. Never a message, never a value. */
export const COOLIFY_SECRET_WIRE_CODES = ["ok", "bad_mac", "bad_payload", "no_key", "key_prev", "unsupported_cipher", "unsupported_serialization", "column_missing", "too_large"] as const;
export type CoolifySecretWireCode = (typeof COOLIFY_SECRET_WIRE_CODES)[number];

/** The sealed envelope: `tse1.` + base64url body. Per value: ephemeral X25519, HKDF-SHA256, AES-256-GCM. */
export const COOLIFY_SEALED_PREFIX = "tse1.";
export const COOLIFY_SEAL_HKDF_INFO = "tugra/coolify-secret/v1";
export const COOLIFY_SEAL_PAD_BYTES = 64;
export const COOLIFY_SECRETS_MAX_REFS_PER_FRAME = 200;
/** Frame `exp` may be at most this far ahead of the agent's clock (seconds). */
export const COOLIFY_FRAME_MAX_EXP_SEC = 15 * 60;
/** Consent windows in hours: default and maximum for the secret grant; the SSH grant is shorter. */
export const COOLIFY_SECRETS_GRANT_DEFAULT_HOURS = 24;
export const COOLIFY_SECRETS_GRANT_MAX_HOURS = 24 * 7;
export const COOLIFY_SSH_GRANT_DEFAULT_HOURS = 2;
export const COOLIFY_SSH_GRANT_MAX_HOURS = 8;

/** Hub -> Agent: ask for sealed values. `refs` are `kind:uuid`; `recipientKey` is the run's public X25519 key (base64, 32 bytes). */
export interface CoolifySecretsReqMsg {
  type: "coolify_secrets_req";
  reqId: string;
  runId: string;
  classes: CoolifySecretClass[];
  refs: string[];
  recipientKey: string;
  exp: number; // unix seconds
  capability: "coolify_secrets";
  sig?: string;
}

/** One value: sealed, or the reason it could not be read. `env` is the tse1 envelope, never plaintext. */
export type CoolifySecretRecord =
  | { ref: string; field: string; class: CoolifySecretClass; env: string }
  | { ref: string; field: string; code: Exclude<CoolifySecretWireCode, "ok"> };

/** Agent -> Hub: the records of one request (relayed as they are; the agent never parses the envelope). */
export interface CoolifySecretsResultMsg {
  type: "coolify_secrets_result";
  reqId: string;
  ok: boolean;
  code?: string;
  records?: CoolifySecretRecord[];
  final?: boolean;
}

/** A value the run could not read, as the plan and the review screen show it. Names and a fixed code only. */
export interface UnreadableValue {
  itemRef: string;
  field: string;
  code: Exclude<CoolifySecretWireCode, "ok">;
}

export type CoolifyGrantKind = "secrets" | "ssh";
export type CoolifyGrantStatus = "active" | "expired" | "revoked";

/** A grant as the API returns it. No key material, no values. */
export interface CoolifyHostGrantView {
  id: string;
  kind: CoolifyGrantKind;
  serverId: string;
  classes: CoolifySecretClass[];
  status: CoolifyGrantStatus;
  grantedById: string;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
}

/** Owner-only request body. `confirm` is the typed Coolify host name (secrets) or the server count (SSH). */
export interface CoolifyGrantRequest {
  serverId: string;
  kind: CoolifyGrantKind;
  classes?: CoolifySecretClass[];
  hours?: number;
  confirm: string;
}
