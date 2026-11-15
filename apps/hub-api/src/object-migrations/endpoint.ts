import { z } from "zod";

/**
 * Validation of a user-supplied S3 endpoint for the object-migration helper (SSRF + injection hygiene).
 *
 *  - http / https ONLY, no userinfo, no path/query/fragment (the credentials travel in env, never in the URL);
 *  - the host must not be 0.0.0.0, link-local (169.254.0.0/16, fe80::/10: the cloud metadata range) or a loopback
 *    literal. Loopback INSIDE the helper container is the helper itself, so a same-host MinIO is addressed as
 *    `host.docker.internal` (the helper runs with `--add-host host.docker.internal:host-gateway`), which IS allowed;
 *  - private ranges are allowed (a private MinIO is the normal case): this is the same exposure class as the existing
 *    S3 backup destination. No `--insecure` anywhere.
 * Pure; returns the normalised `scheme://host[:port]` or a stable reason code.
 */
export type EndpointCheck = { ok: true; endpoint: string; host: string } | { ok: false; reason: "invalid" | "scheme" | "userinfo" | "path" | "blocked_host" };

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function blockedHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "::1" || h === "::" || h === "0:0:0:0:0:0:0:1" || h === "0:0:0:0:0:0:0:0") return true;
  if (/^fe[89ab][0-9a-f]:/i.test(h)) return true; // fe80::/10 link-local
  const m = IPV4.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
  }
  // IPv4-mapped / IPv4-compatible IPv6 must not smuggle a blocked v4 past the check. The WHATWG URL parser rewrites
  // `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]`, so the embedded address is recovered from the last two hextets.
  const embedded = embeddedV4(h);
  if (embedded) return blockedHost(embedded);
  return false;
}

/** The IPv4 inside `::ffff:a.b.c.d`, `::ffff:xxxx:xxxx`, `::a.b.c.d` or `::xxxx:xxxx` (mapped/compatible forms), else null. */
function embeddedV4(h: string): string | null {
  const dotted = /^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(h);
  if (dotted) return dotted[1];
  const hex = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(h);
  if (!hex) return null;
  const hi = parseInt(hex[1], 16);
  const lo = parseInt(hex[2], 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

export function checkS3Endpoint(raw: string): EndpointCheck {
  const v = (raw ?? "").trim();
  if (!v || /[\s\u0000-\u001f\u007f\\'"`$]/.test(v)) return { ok: false, reason: "invalid" };
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, reason: "scheme" };
  if (u.username || u.password) return { ok: false, reason: "userinfo" };
  if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) return { ok: false, reason: "path" };
  // A hostname is letters/digits/dot/hyphen/underscore or a bracketed IPv6 literal: anything else (`;`, `|`, `&` ...) is refused.
  if (!/^(?:[a-z0-9_][a-z0-9_.-]*|\[[0-9a-f:.]+\])$/i.test(u.hostname)) return { ok: false, reason: "invalid" };
  if (blockedHost(u.hostname)) return { ok: false, reason: "blocked_host" };
  return { ok: true, endpoint: `${u.protocol}//${u.host}`, host: u.hostname.toLowerCase() };
}

/** zod `superRefine` for the DTO: one issue with the stable reason code as its message. */
export function isSafeS3Endpoint(v: string, ctx: z.RefinementCtx): void {
  const r = checkS3Endpoint(v);
  if (!r.ok) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `invalid_endpoint:${r.reason}` });
}
