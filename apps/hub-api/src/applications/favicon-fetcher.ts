import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { isIP } from "node:net";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { ipv6ToBytes } from "../importer/sources/ssrf-guard";

/** Largest favicon (and largest slice of a page read to find its <link rel=icon>) the hub will take. */
export const FAVICON_MAX_BYTES = 100 * 1024;
/** One request. A site that does not answer in this time has no favicon for us. */
export const FAVICON_TIMEOUT_MS = 3_000;
/** All requests for one app together. */
export const FAVICON_DEADLINE_MS = 8_000;
const MAX_REDIRECTS = 3;

export interface FaviconRequest {
  scheme: "https" | "http";
  host: string;
  path: string;
}
export interface FaviconResponse {
  status: number;
  contentType: string | null;
  location: string | null;
  body: Buffer;
}
export type FaviconTransport = (r: FaviconRequest) => Promise<FaviconResponse>;
export interface FoundFavicon {
  mime: string;
  data: Buffer;
}

/**
 * True only for a routable public address. Stricter than the import guard (which allows a private network on
 * purpose): here loopback, private (RFC 1918), shared/CGNAT, link-local, multicast and reserved ranges are all
 * refused, for IPv4 and IPv6, and any IPv4 embedded in an IPv6 form is unwrapped and checked as IPv4.
 */
export function isPublicIp(ip: string): boolean {
  const host = ip.replace(/^\[|\]$/g, "");
  const kind = isIP(host);
  if (kind === 4) return publicV4(host.split(".").map(Number));
  if (kind === 6) {
    const b = ipv6ToBytes(host);
    if (!b) return false;
    const zeros = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
    if (zeros(0, 16)) return false; // ::
    if (zeros(0, 15) && b[15] === 1) return false; // ::1
    if (zeros(0, 10) && b[10] === 0xff && b[11] === 0xff) return publicV4(b.slice(12)); // v4-mapped
    if (zeros(0, 12)) return publicV4(b.slice(12)); // v4-compatible
    if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zeros(4, 12)) return publicV4(b.slice(12)); // NAT64
    if ((b[0] & 0xfe) === 0xfc) return false; // fc00::/7 unique local
    if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return false; // fe80::/10 link-local
    if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return false; // fec0::/10 site-local (deprecated)
    if (b[0] === 0xff) return false; // multicast
    if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return false; // documentation
    return (b[0] & 0xe0) === 0x20; // only global unicast 2000::/3 is routable today
  }
  return false;
}

function publicV4(o: number[]): boolean {
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b, c] = o;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  if (a === 169 && b === 254) return false; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // protocol assignments, documentation
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // documentation
  if (a === 203 && b === 0 && c === 113) return false; // documentation
  if (a >= 224) return false; // multicast, reserved, broadcast
  return true;
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** Resolve, refuse the whole name if ANY answer is not public, and pin the connection to a validated address. */
export function publicLookup(hostname: string, options: unknown, callback: LookupCb): void {
  dnsLookup(hostname, { all: true, verbatim: true }, (err, resolved) => {
    if (err) return callback(err, "", 0);
    const list = resolved as LookupAddress[];
    if (!list.length) return callback(new Error("no DNS records"), "", 0);
    if (list.some((a) => !isPublicIp(a.address))) return callback(new Error("blocked-address"), "", 0);
    if (options && typeof options === "object" && (options as { all?: boolean }).all) {
      return (callback as unknown as (e: null, r: LookupAddress[]) => void)(null, list);
    }
    callback(null, list[0].address, list[0].family);
  });
}

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** A configured domain, normalised, or null when it is not a plain DNS name (an IP, a wildcard, a path, junk). */
export function cleanHost(raw: string | null | undefined): string | null {
  const h = (raw ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (!h || isIP(h) !== 0 || !HOST_RE.test(h)) return null;
  return h;
}

const head = (v: string | string[] | undefined): string | null => (Array.isArray(v) ? v[0] ?? null : v ?? null);

/** The real transport: one GET, redirects not followed, body capped, certificate checked, DNS through publicLookup. */
export const realFaviconTransport: FaviconTransport = (r) =>
  new Promise<FaviconResponse>((resolve, reject) => {
    const https = r.scheme === "https";
    let settled = false;
    let hardStop: NodeJS.Timeout | undefined;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (hardStop) clearTimeout(hardStop);
      fn();
    };
    const req = (https ? httpsRequest : httpRequest)(
      {
        host: r.host,
        port: https ? 443 : 80,
        path: r.path,
        method: "GET",
        headers: { Host: r.host, "User-Agent": "tugra-favicon", Accept: "image/*,text/html;q=0.8", "Accept-Encoding": "identity" },
        lookup: publicLookup,
        timeout: FAVICON_TIMEOUT_MS,
        ...(https ? { servername: r.host } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let len = 0;
        const out = (): FaviconResponse => ({
          status: res.statusCode ?? 0,
          contentType: head(res.headers["content-type"]),
          location: head(res.headers.location),
          body: Buffer.concat(chunks),
        });
        res.on("data", (c: Buffer) => {
          if (settled) return;
          const room = FAVICON_MAX_BYTES + 1 - len;
          chunks.push(c.length > room ? c.subarray(0, room) : c);
          len += Math.min(c.length, room);
          if (len > FAVICON_MAX_BYTES) {
            req.destroy();
            finish(() => resolve(out()));
          }
        });
        res.on("end", () => finish(() => resolve(out())));
        res.on("error", (e) => finish(() => reject(e)));
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    // The socket timeout only fires on silence; this caps the whole request so a slow trickle cannot hold a slot.
    hardStop = setTimeout(() => req.destroy(new Error("timeout")), FAVICON_TIMEOUT_MS);
    req.on("error", (e) => finish(() => reject(e)));
    req.end();
  });

/** The raster type of `buf` by its leading bytes, or null. SVG and anything scriptable is deliberately not accepted. */
export function sniffImage(buf: Buffer): string | null {
  if (buf.length < 8) return null;
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0 && buf[4] > 0) return "image/x-icon";
  if (buf.subarray(0, 3).toString("latin1") === "GIF") return "image/gif";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 12 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

/** Icon URLs named by <link rel="icon"> style tags in the first bytes of a page, best candidates first. */
export function iconLinksFromHtml(html: string): string[] {
  const found: { href: string; rank: number }[] = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = /\brel\s*=\s*["']?([^"'>]+)["']?/i.exec(tag)?.[1]?.toLowerCase() ?? "";
    if (!/\bicon\b|apple-touch-icon/.test(rel)) continue;
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const value = (href?.[1] ?? href?.[2] ?? href?.[3] ?? "").trim();
    if (!value || /^(data|javascript):/i.test(value)) continue;
    const size = Number(/\bsizes\s*=\s*["']?(\d+)x\d+/i.exec(tag)?.[1] ?? 0);
    // Prefer a 32-64px icon: sharp at tile size without being a large download.
    const rank = size >= 32 && size <= 64 ? 0 : size === 0 ? 1 : size < 32 ? 2 : 3;
    found.push({ href: value, rank: /apple-touch/.test(rel) ? rank + 4 : rank });
  }
  return found.sort((a, b) => a.rank - b.rank).map((f) => f.href);
}

const isStdPort = (u: URL) => !u.port || u.port === (u.protocol === "https:" ? "443" : "80");

/**
 * Find the favicon of an app's own site (its first configured hostname). Only the app's configured hostnames are
 * ever contacted: a redirect or an icon URL that leaves that set (apart from www.<host> / <host>) is ignored. Every
 * hostname must resolve to public addresses only. Tries /favicon.ico, then the <link rel=icon> of the home page.
 * Never throws; null = none found.
 */
export async function findFavicon(
  domains: ReadonlyArray<string | null | undefined>,
  opts: { transport?: FaviconTransport; schemes?: ReadonlyArray<"https" | "http"> } = {},
): Promise<FoundFavicon | null> {
  const transport = opts.transport ?? realFaviconTransport;
  const schemes = opts.schemes ?? (["https", "http"] as const);
  const hosts = domains.map(cleanHost).filter((h): h is string => !!h);
  if (hosts.length === 0) return null;
  const primary = hosts[0];
  const allowed = new Set<string>();
  for (const h of hosts) {
    allowed.add(h);
    allowed.add(h.startsWith("www.") ? h.slice(4) : `www.${h}`);
  }
  const deadline = Date.now() + FAVICON_DEADLINE_MS;

  /** GET with redirects limited to allowed hosts; null on any failure or a non-200 answer. */
  const get = async (scheme: "https" | "http", host: string, path: string): Promise<{ res: FaviconResponse; host: string } | null> => {
    let cur: FaviconRequest = { scheme, host, path };
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      if (Date.now() > deadline || !allowed.has(cur.host)) return null;
      let res: FaviconResponse;
      try {
        res = await transport(cur);
      } catch {
        return null;
      }
      if (res.status >= 300 && res.status < 400 && res.location) {
        let next: URL;
        try {
          next = new URL(res.location, `${cur.scheme}://${cur.host}${cur.path}`);
        } catch {
          return null;
        }
        if ((next.protocol !== "https:" && next.protocol !== "http:") || next.username || next.password || !isStdPort(next)) return null;
        cur = { scheme: next.protocol === "https:" ? "https" : "http", host: next.hostname.toLowerCase(), path: next.pathname + next.search };
        continue;
      }
      return res.status === 200 ? { res, host: cur.host } : null;
    }
    return null;
  };

  const asIcon = (res: FaviconResponse): FoundFavicon | null => {
    if (!res.contentType || !/^image\//i.test(res.contentType)) return null;
    if (res.body.length === 0 || res.body.length > FAVICON_MAX_BYTES) return null;
    const mime = sniffImage(res.body);
    return mime ? { mime, data: res.body } : null;
  };

  for (const scheme of schemes) {
    const direct = await get(scheme, primary, "/favicon.ico");
    const hit = direct && asIcon(direct.res);
    if (hit) return hit;
    const page = await get(scheme, primary, "/");
    if (!page || !/^text\/html|^application\/xhtml/i.test(page.res.contentType ?? "")) continue;
    for (const href of iconLinksFromHtml(page.res.body.toString("utf8")).slice(0, 3)) {
      let u: URL;
      try {
        u = new URL(href, `${scheme}://${page.host}/`);
      } catch {
        continue;
      }
      if ((u.protocol !== "https:" && u.protocol !== "http:") || !allowed.has(u.hostname.toLowerCase()) || !isStdPort(u)) continue;
      const icon = await get(u.protocol === "https:" ? "https" : "http", u.hostname.toLowerCase(), u.pathname + u.search);
      const found = icon && asIcon(icon.res);
      if (found) return found;
    }
  }
  return null;
}
