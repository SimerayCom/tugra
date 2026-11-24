import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { isIP } from "node:net";
import type { LookupAddress } from "node:dns";
import { assertAllowedUrl, guardedLookup, isBlockedIp } from "../importer/sources/ssrf-guard";
import { CUTOVER_HOSTNAME_RE, PROBE_PATH_RE } from "../cutover/cutover.logic";
import { EMPTY_SAMPLE, samplePage, type PageSample } from "./verify-compare";

/** One read of one page. `ip` set = connect to that address and present `host` (SNI + Host header): the target's preview. */
export interface FetchTarget {
  host: string;
  path: string;
  ip?: string;
  scheme: "https" | "http";
}

export interface RawPage {
  status: number;
  contentType: string | null;
  location: string | null;
  body: Buffer;
  truncated: boolean;
}

export type PageTransport = (t: FetchTarget) => Promise<RawPage>;

const TIMEOUT_MS = 8_000;
const DEADLINE_MS = 15_000;
/** Enough of a page to tell two copies apart; a larger body is hashed up to here and flagged `truncated`. */
export const MAX_PAGE_BYTES = 512 * 1024;

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** A lookup that always answers with one validated address (the target server's own), never DNS. */
function pinnedLookup(ip: string) {
  const family = isIP(ip) === 6 ? 6 : 4;
  return (_host: string, options: unknown, cb: LookupCb) => {
    if (options && typeof options === "object" && (options as { all?: boolean }).all) return (cb as unknown as (e: null, r: LookupAddress[]) => void)(null, [{ address: ip, family }]);
    cb(null, ip, family);
  };
}

/**
 * The real transport: ONE GET, redirects NOT followed (a redirect is part of what is compared), body capped, certificate
 * not enforced (the page is compared, not trusted; a preview may still hold a default certificate). The source side resolves
 * through the SSRF guard (loopback, link-local and metadata refused, every resolved address checked); the target side connects
 * to a pinned address that must pass the same guard. Hostname and path are validated again here, defence in depth.
 */
export const realTransport: PageTransport = (t) =>
  new Promise<RawPage>((resolve, reject) => {
    if (!CUTOVER_HOSTNAME_RE.test(t.host) || !PROBE_PATH_RE.test(t.path)) return reject(new Error("invalid-target"));
    if (t.ip) {
      if (isIP(t.ip) === 0 || isBlockedIp(t.ip)) return reject(new Error("blocked-address"));
    } else {
      try {
        assertAllowedUrl(`${t.scheme}://${t.host}${t.path}`);
      } catch {
        return reject(new Error("blocked-address"));
      }
    }
    const https = t.scheme === "https";
    const doRequest = https ? httpsRequest : httpRequest;
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      fn();
    };
    const req = doRequest(
      {
        host: t.host,
        port: https ? 443 : 80,
        path: t.path,
        method: "GET",
        headers: { Host: t.host, "User-Agent": "tugra-verify", Accept: "text/html,application/json;q=0.9,*/*;q=0.5", "Accept-Encoding": "identity" },
        lookup: t.ip ? pinnedLookup(t.ip) : guardedLookup,
        timeout: TIMEOUT_MS,
        ...(https ? { servername: t.host, rejectUnauthorized: false } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let len = 0;
        let truncated = false;
        res.on("data", (c: Buffer) => {
          if (len >= MAX_PAGE_BYTES) return;
          const room = MAX_PAGE_BYTES - len;
          if (c.length > room) {
            chunks.push(c.subarray(0, room));
            len = MAX_PAGE_BYTES;
            truncated = true;
            req.destroy();
            return done(() => resolve({ status: res.statusCode ?? 0, contentType: header(res.headers["content-type"]), location: header(res.headers.location), body: Buffer.concat(chunks), truncated }));
          }
          chunks.push(c);
          len += c.length;
        });
        res.on("end", () => done(() => resolve({ status: res.statusCode ?? 0, contentType: header(res.headers["content-type"]), location: header(res.headers.location), body: Buffer.concat(chunks), truncated })));
        res.on("error", (e) => done(() => reject(e)));
      },
    );
    const deadline = setTimeout(() => req.destroy(new Error("timeout")), DEADLINE_MS);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => done(() => reject(e)));
    req.end();
  });

const header = (v: string | string[] | undefined): string | null => (Array.isArray(v) ? v[0] ?? null : v ?? null);

/** A short fixed code for a transport failure; the message (which may name an address) is never kept. */
export function fetchErrorCode(e: unknown): string {
  const m = e instanceof Error ? e.message : "";
  if (/blocked-address|SSRF guard/.test(m)) return "blocked-address";
  if (/invalid-target/.test(m)) return "invalid-target";
  if (/timeout|ETIMEDOUT/i.test(m)) return "timeout";
  return "unreachable";
}

/** Read one page over https, falling back to http only when https did not connect. Never throws. */
export async function samplePageAt(host: string, path: string, ip: string | undefined, transport: PageTransport = realTransport): Promise<PageSample> {
  let lastError = "unreachable";
  for (const scheme of ["https", "http"] as const) {
    try {
      return samplePage(await transport({ host, path, ip, scheme }), host);
    } catch (e) {
      lastError = fetchErrorCode(e);
      if (lastError === "blocked-address" || lastError === "invalid-target") break; // retrying plain http cannot change that
    }
  }
  return { ...EMPTY_SAMPLE, error: lastError };
}
