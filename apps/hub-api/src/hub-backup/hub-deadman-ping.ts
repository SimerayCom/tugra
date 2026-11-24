import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { assertAllowedUrl, guardedLookup } from "../importer/sources/ssrf-guard";

export interface PingResult {
  ok: boolean;
  status: number | null;
  /** A short fixed reason, never the URL or any response text. */
  error: string | null;
}

const PING_TIMEOUT_MS = 10_000;

/** Validate a check-in URL the way the hub will fetch it: http(s) only, no embedded credentials, no loopback/link-local/metadata. */
export function assertPingUrl(raw: string): URL {
  try {
    return assertAllowedUrl(raw);
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : "invalid URL");
  }
}

/** The host of a stored URL for display. The path/query usually carry the monitor's token, so they never leave the hub. */
export function pingHostHint(raw: string): string | null {
  try {
    return new URL(raw).host;
  } catch {
    return null;
  }
}

/**
 * One SSRF-pinned GET. Redirects are refused (a 3xx is a known pivot), the body is drained and discarded, and the
 * result carries only a status and a fixed reason code, so a token in the URL cannot leak through an error.
 */
export function pingOnce(raw: string): Promise<PingResult> {
  return new Promise((resolve) => {
    let u: URL;
    try {
      u = assertPingUrl(raw);
    } catch {
      return resolve({ ok: false, status: null, error: "invalid-url" });
    }
    let done = false;
    const finish = (r: PingResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const doRequest = u.protocol === "https:" ? httpsRequest : httpRequest;
    const req = doRequest(u, { method: "GET", lookup: guardedLookup, headers: { "User-Agent": "tugra-hub-checkin" } }, (res) => {
      const status = res.statusCode ?? 0;
      res.resume();
      if (status >= 300 && status < 400) return finish({ ok: false, status, error: "redirect-refused" });
      finish(status >= 200 && status < 300 ? { ok: true, status, error: null } : { ok: false, status, error: "bad-status" });
    });
    const timer = setTimeout(() => {
      req.destroy();
      finish({ ok: false, status: null, error: "timeout" });
    }, PING_TIMEOUT_MS);
    req.on("error", (e: NodeJS.ErrnoException) => finish({ ok: false, status: null, error: /SSRF guard/.test(e.message) ? "blocked-address" : "unreachable" }));
    req.end();
  });
}
