/**
 * Coolify hub takeover, lane B (sealed secret pipeline): the shared vocabulary. Types and constants only; no behaviour.
 * The agent reads Coolify's own database on its host, decrypts values there and seals each one to a per-run X25519 key
 * (envelope "tse1"); the hub opens it in one function. Plaintext never rides the wire, a log or an audit row.
 * Lane B owns this file. Other lanes only import from it.
 */

/** What an agent may be asked to read: the `kind` half of a `kind:uuid` ref. */
export const COOLIFY_SECRET_REF_KINDS = ["env", "shared_env", "database", "service", "application", "scheduled_task", "s3", "notification", "git_app", "private_key", "file_volume"] as const;
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

/**
 * The classes an IMPORT reads: what an apply needs for its apps to arrive complete (variables, shared variables expanded into them, compose and
 * Dockerfile and label text, engine config), and the two the settings import reads when the owner allows them. The consent card offers exactly
 * these; the other classes are not read by any import yet, so allowing them would grant nothing the import uses.
 */
export const COOLIFY_IMPORT_APPLY_CLASSES: readonly CoolifySecretClass[] = ["env", "shared_env", "service_compose", "db_credentials"];
export const COOLIFY_IMPORT_SETTINGS_CLASSES: readonly CoolifySecretClass[] = ["notification", "task_command"];
export const COOLIFY_IMPORT_READ_CLASSES: readonly CoolifySecretClass[] = [...COOLIFY_IMPORT_APPLY_CLASSES, ...COOLIFY_IMPORT_SETTINGS_CLASSES];

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

// This package compiles without DOM/node typings yet runs in node and the browser, where TextEncoder is a global.
declare const TextEncoder: new () => { encode(input: string): { length: number } };
const SECRETS_ENC = new TextEncoder();
function lp(v: string | number): string {
  const s = String(v);
  return `${SECRETS_ENC.encode(s).length}:${s}`;
}

/** Everything the hub signs on a `coolify_secrets_req`. `serverId` is the target agent's id: it is signed but not sent, the agent checks it against its OWN stored id. */
export interface CoolifySecretsSigFields {
  serverId: string;
  reqId: string;
  runId: string;
  classes: readonly string[];
  refs: readonly string[];
  recipientKey: string;
  exp: number;
  capability: string;
}

/**
 * Signed payload: "coolify_secrets\n" + 8 fields in this order, each `<utf8ByteLength>:<value>`, joined by "\n"; the class and ref lists are
 * joined with ",". Must stay byte-identical to the Go `protocol.CanonicalCoolifySecrets` (both assert the same golden string).
 */
export function canonicalCoolifySecrets(f: CoolifySecretsSigFields): string {
  return (
    "coolify_secrets\n" +
    [f.serverId, f.reqId, f.runId, f.classes.join(","), f.refs.join(","), f.recipientKey, f.exp, f.capability].map(lp).join("\n")
  );
}

/** The AAD of one `tse1` envelope: the value is bound to its run, agent, ref (`kind:uuid`), field and class (NUL separated, no part may contain NUL). */
export function coolifySealAad(c: { runId: string; serverId: string; ref: string; field: string; cls: string }): string {
  const parts = [c.runId, c.serverId, c.ref, c.field, c.cls];
  for (const p of parts) if (p === "" || p.includes("\u0000")) throw new Error("bad seal context");
  return parts.join("\u0000");
}

/** Refusal codes an agent may answer a frame with (a closed set); anything else is treated as "failed". */
export const COOLIFY_SECRETS_REFUSAL_CODES = ["expired", "replay", "denied", "bad_request", "busy", "rate_limited", "not_configured", "failed", "revoked"] as const;
export type CoolifySecretsRefusalCode = (typeof COOLIFY_SECRETS_REFUSAL_CODES)[number];

/** The ref of a value as the agent knows it: `kind:id`. The id charset is what the agent's SQL allows. */
export const COOLIFY_SECRET_REF_RE = /^[a-z0-9_]{1,20}:[A-Za-z0-9_-]{1,64}$/;
