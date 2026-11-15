import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Signed, single-use, memory-only relay URLs for ONE bounded part of an app move's volume data. The source agent PUTs
 * the part, the target agent GETs it; the hub only pipes bytes between the two sockets. The agent receives only the
 * RELATIVE path (it prefixes its own configured hub origin), and the HMAC binds every field of the claim: relay id,
 * role (src = the PUT, dst = the GET), the server that may use it, the move/volume/part it carries, and the exact
 * size + sha256 of the part, plus a short expiry.
 */

export type RelayRole = "src" | "dst";

export interface RelayClaim {
  id: string;
  role: RelayRole;
  serverId: string;
  moveId: string;
  volIdx: number;
  part: number;
  size: number;
  sha256: string;
}

/** Served under the global /api/v1 prefix; the controller is excluded from the OpenAPI document. */
export const RELAY_PATH = "/api/v1/agent-vx/t";
/** Longest validity a minted URL (and a verified exp) may have. */
export const RELAY_MAX_HORIZON_MS = 10 * 60 * 1000;

/** Domain-separated from the fs-transfer key (`tugra-fs-transfer-v1`) and the migration artifact key, so a URL minted
 *  for one of those can never verify as a relay URL (and vice versa). */
export const RELAY_HKDF_LABEL = "tugra-vol-relay-v1";

function deriveKey(secret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.alloc(0), RELAY_HKDF_LABEL, 32));
}

export function relayPayload(c: RelayClaim, exp: number): string {
  return `v1|${c.id}|${c.role}|${c.serverId}|${c.moveId}|${c.volIdx}|${c.part}|${c.size}|${c.sha256}|${exp}`;
}

function sign(secret: string, c: RelayClaim, exp: number): string {
  return createHmac("sha256", deriveKey(secret)).update(relayPayload(c, exp)).digest("base64url");
}

/** A fresh unguessable relay id (24 random bytes, base64url). */
export function newRelayId(): string {
  return randomBytes(24).toString("base64url");
}

/** `/api/v1/agent-vx/t/<id>?exp=<unix s>&sig=<hmac>` — the relative path the agent is signed to request. */
export function mintRelayPath(secret: string, claim: RelayClaim, expSec: number): string {
  return `${RELAY_PATH}/${claim.id}?exp=${expSec}&sig=${sign(secret, claim, expSec)}`;
}

/** Constant-time verify of a presented (claim, exp, sig). exp must be an integer in (now, now + 10 min]. */
export function verifyRelaySig(secret: string, claim: RelayClaim, exp: number, sig: string, nowMs: number): boolean {
  if (!Number.isInteger(exp) || exp * 1000 <= nowMs || exp * 1000 > nowMs + RELAY_MAX_HORIZON_MS) return false;
  if (typeof sig !== "string" || sig.length > 128) return false;
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(secret, claim, exp));
  return a.length === b.length && timingSafeEqual(a, b);
}
