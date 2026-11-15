import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { Transform, type TransformCallback } from "node:stream";

// A short-lived, single-use, HMAC-signed rendezvous URL for ONE file body moving between the hub and an agent
// (an upload the agent pulls, or a download the agent pushes). The agent receives only the RELATIVE path (it
// builds the host from its own configured hub origin), and the signature binds every field of the claim.

export type XferDir = "to-agent" | "from-agent";

export interface XferClaim {
  id: string;
  dir: XferDir;
  serverId: string;
  size: number;
  sha256: string; // "" for a download (the bytes do not exist yet)
}

// Served under the global /api/v1 prefix. The `agent-fs` controller is excluded from the OpenAPI document.
const XFER_PATH = "/api/v1/agent-fs/t";
// An exp further out than this is refused even with a valid MAC (defence against a mis-minted URL).
const MAX_HORIZON_MS = 2 * 60 * 60 * 1000;

/** Domain-separated from the migration artifact key (distinct HKDF label), so neither URL can be replayed as the other. */
function deriveKey(secret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.alloc(0), "tugra-fs-transfer-v1", 32));
}

function sign(secret: string, c: XferClaim, exp: number): string {
  const payload = `v1|${c.id}|${c.dir}|${c.serverId}|${c.size}|${c.sha256}|${exp}`;
  return createHmac("sha256", deriveKey(secret)).update(payload).digest("base64url");
}

/** A fresh unguessable transfer id (24 random bytes, base64url). */
export function newXferId(): string {
  return randomBytes(24).toString("base64url");
}

/** `/api/v1/agent-fs/t/<id>?exp=<unix s>&sig=<hmac>` — the relative path the agent is signed to request. */
export function mintXferPath(secret: string, claim: XferClaim, expSec: number): string {
  return `${XFER_PATH}/${claim.id}?exp=${expSec}&sig=${sign(secret, claim, expSec)}`;
}

/** Constant-time verify of a presented (claim, exp, sig). Rejects an expired, non-integer or too-far-future exp. */
export function verifyXferSig(secret: string, claim: XferClaim, exp: number, sig: string, nowMs: number): boolean {
  if (!Number.isInteger(exp) || exp * 1000 <= nowMs || exp * 1000 > nowMs + MAX_HORIZON_MS) return false;
  if (typeof sig !== "string" || sig.length > 128) return false;
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(secret, claim, exp));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Passes bytes through and fails the stream if the total is ever not exactly `size`. */
export function byteCounter(size: number): Transform {
  let n = 0;
  return new Transform({
    transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
      n += chunk.length;
      if (n > size) return cb(new Error("body longer than declared"));
      cb(null, chunk);
    },
    flush(cb: TransformCallback) {
      cb(n === size ? null : new Error("body shorter than declared"));
    },
  });
}

/**
 * Content-Disposition for a DOWNLOAD: always `attachment` (never inline), an ASCII-safe `filename=` fallback with
 * quotes/backslashes/control characters removed, and an RFC 5987 `filename*=UTF-8''` carrying the real name.
 */
export function attachmentDisposition(basename: string): string {
  const name = basename.length > 0 ? basename : "download";
  // eslint-disable-next-line no-control-regex
  const ascii = name.replace(/[\u0000-\u001f\u007f"\\;%]/g, "_").replace(/[^\u0020-\u007e]/g, "_").slice(0, 150) || "download";
  const pct = encodeURIComponent(name.replace(/[\u0000-\u001f\u007f]/g, "_")).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${pct}`;
}
