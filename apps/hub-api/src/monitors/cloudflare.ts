/**
 * Cloudflare answers 520-526 itself when it reaches the site's edge but cannot get a good answer from the ORIGIN
 * server behind it. Those are origin/connection problems, not an application error, so the monitor tags them with a
 * machine-readable cause ("cf:522") and the web app shows a localized "Cloudflare <-> origin" label with the likely
 * reason. The mapping below is the hub's side of that contract; the wording lives in the web locale files.
 */

/** The codes Cloudflare documents for edge <-> origin failures. */
export const CLOUDFLARE_ORIGIN_CODES = [520, 521, 522, 523, 524, 525, 526] as const;

export type CloudflareReason =
  | "unknown_response" // 520: origin sent an empty / malformed / oversized-header answer
  | "origin_down" // 521: the origin refused the connection (web server stopped or not listening)
  | "connect_timeout" // 522: no TCP answer in time (origin down, overloaded, or a firewall drops Cloudflare)
  | "unreachable" // 523: no route / wrong IP in DNS
  | "timeout" // 524: connected, but the origin took too long to answer
  | "ssl_handshake" // 525: TLS handshake with the origin failed (SSL mode does not match the origin)
  | "ssl_invalid"; // 526: origin certificate rejected under "Full (strict)"

const REASONS: Record<number, CloudflareReason> = {
  520: "unknown_response",
  521: "origin_down",
  522: "connect_timeout",
  523: "unreachable",
  524: "timeout",
  525: "ssl_handshake",
  526: "ssl_invalid",
};

/** The cause tag for an HTTP status, or null when the status is not a Cloudflare origin failure. */
export function cloudflareCause(status: number): string | null {
  return REASONS[status] ? `cf:${status}` : null;
}

/** The likely reason class behind a "cf:<code>" cause (null for anything else). */
export function cloudflareReason(cause: string | null | undefined): CloudflareReason | null {
  const m = /^cf:(\d{3})$/.exec(cause ?? "");
  return m ? (REASONS[Number(m[1])] ?? null) : null;
}

/** Short English line for logs and plain-text notifications (the web app localizes from the cause instead). */
export function cloudflareSummary(status: number): string {
  return `HTTP ${status} (Cloudflare <-> origin)`;
}
