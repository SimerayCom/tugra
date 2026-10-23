import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

// A short-lived, HMAC-signed capability URL for ONE staged migration artifact. The hub mints it immediately
// before a restore and the TARGET agent's `curl` fetches it (the source host never sees or supplies a URL).
// The signature binds the op + task + the hub-computed CONTENT HASH, so a re-upload (new sha) invalidates
// every older URL, and a leaked URL is useless once the sha no longer matches or the restore window closes.
export const MIGRATION_DL_TTL_MS = 15 * 60 * 1000; // comfortably exceeds the 5-min restore command timeout

// Served under the global /api/v1 prefix (app-config.ts) — NOT excluded, because the hub generates the whole
// URL (unlike install/agent.sh, which a human types). Kept here so mint + route agree.
const DL_PATH = "/api/v1/import/migration/dl";

export interface ArtifactClaim {
  opId: string;
  taskId: string;
  sha256: string;
}

/** Separate key from the raw passphrase so a leak of one artifact MAC never exposes the secrets key. */
function deriveKey(secret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.alloc(0), "tugra-migration-artifact-v1", 32));
}

function sign(secret: string, c: ArtifactClaim, exp: number): string {
  const payload = `v1|${c.opId}|${c.taskId}|${c.sha256}|${exp}`;
  return createHmac("sha256", deriveKey(secret)).update(payload).digest("base64url");
}

/** The absolute dl URL + its unix-second expiry. `base` is the hub's agent-reachable origin (no trailing slash). */
export function mintArtifactUrl(base: string, secret: string, claim: ArtifactClaim, nowMs: number): { url: string; exp: number } {
  const exp = Math.floor((nowMs + MIGRATION_DL_TTL_MS) / 1000);
  const sig = sign(secret, claim, exp);
  // `.bin` is cosmetic: the restore pipeline is told pgFormat explicitly, so it never relies on the URL extension.
  const url = `${base}${DL_PATH}/${claim.taskId}.bin?exp=${exp}&sig=${sig}`;
  return { url, exp };
}

/** Constant-time verify of a presented (claim, exp, sig). Rejects a non-future or too-far-future exp. */
export function verifyArtifactSig(secret: string, claim: ArtifactClaim, exp: number, sig: string, nowMs: number): boolean {
  if (!Number.isInteger(exp) || exp * 1000 <= nowMs || exp * 1000 > nowMs + MIGRATION_DL_TTL_MS + 60_000) return false;
  const expected = sign(secret, claim, exp);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
