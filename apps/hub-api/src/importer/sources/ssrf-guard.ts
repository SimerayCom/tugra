import { isIP } from "node:net";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";

/**
 * SSRF guard for user-supplied import-source URLs. Tugra is self-hosted and a Coolify instance commonly
 * lives on an internal/private network, so private ranges (10/8, 172.16/12, 192.168/16, ULA) are ALLOWED.
 * What is never allowed — never a legitimate Coolify target and the classic escalation path — is loopback,
 * link-local (incl. cloud metadata 169.254.169.254 / fd00:ec2::254), and the unspecified address. Every
 * embedded-IPv4 form (dotted or hex v4-mapped, v4-compatible, NAT64) is unwrapped and checked as IPv4, so
 * `[::ffff:7f00:1]` is treated exactly like `127.0.0.1`.
 */
export function isBlockedIp(ip: string): boolean {
  const host = ip.replace(/^\[|\]$/g, "");
  const kind = isIP(host);
  if (kind === 4) return isBlockedV4Bytes(v4ToBytes(host));
  return isBlockedV6(host); // kind 6, or 0 → parser fails closed
}

function v4ToBytes(ip: string): number[] {
  return ip.split(".").map((n) => Number(n));
}

function isBlockedV4Bytes(o: number[]): boolean {
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true; // fail closed
  if (o[0] === 127) return true; // loopback 127.0.0.0/8
  if (o[0] === 0) return true; // "this host" 0.0.0.0/8
  if (o[0] === 169 && o[1] === 254) return true; // link-local 169.254.0.0/16 (incl. cloud metadata)
  return false;
}

/** Expand any IPv6 text form (incl. an embedded dotted IPv4) to 16 bytes, or null if unparseable. */
function ipv6ToBytes(addr: string): number[] | null {
  let a = addr.toLowerCase().replace(/^\[|\]$/g, "");
  const zone = a.indexOf("%");
  if (zone >= 0) a = a.slice(0, zone); // strip scope id
  // Convert a trailing dotted IPv4 (::ffff:127.0.0.1) into two hextets.
  const v4 = a.match(/^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const o = [Number(v4[2]), Number(v4[3]), Number(v4[4]), Number(v4[5])];
    if (o.some((n) => n > 255)) return null;
    a = `${v4[1]}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  if ((a.match(/::/g) ?? []).length > 1) return null;
  const hasDouble = a.includes("::");
  const [head, tail] = hasDouble ? a.split("::") : [a, ""];
  const headParts = head ? head.split(":") : [];
  const tailParts = hasDouble && tail ? tail.split(":") : [];
  const missing = 8 - headParts.length - tailParts.length;
  if (hasDouble ? missing < 0 : headParts.length !== 8) return null;
  const groups = hasDouble ? [...headParts, ...Array(Math.max(missing, 0)).fill("0"), ...tailParts] : headParts;
  if (groups.length !== 8) return null;
  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const n = parseInt(g, 16);
    bytes.push((n >> 8) & 0xff, n & 0xff);
  }
  return bytes;
}

function isBlockedV6(addr: string): boolean {
  const b = ipv6ToBytes(addr);
  if (!b) return true; // unparseable → fail closed
  const zeros = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  if (zeros(0, 16)) return true; // :: unspecified
  if (zeros(0, 15) && b[15] === 1) return true; // ::1 loopback
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
  // AWS IPv6 IMDS fd00:ec2::254
  if (b[0] === 0xfd && b[1] === 0x00 && b[2] === 0x0e && b[3] === 0xc2 && zeros(4, 14) && b[14] === 0x02 && b[15] === 0x54) return true;
  // Embedded IPv4: ::ffff:0:0/96 (v4-mapped), ::/96 (v4-compatible), 64:ff9b::/96 (NAT64) → check as IPv4.
  if (zeros(0, 10) && b[10] === 0xff && b[11] === 0xff) return isBlockedV4Bytes(b.slice(12));
  if (zeros(0, 12)) return isBlockedV4Bytes(b.slice(12));
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zeros(4, 12)) return isBlockedV4Bytes(b.slice(12));
  return false;
}

/** Parse + validate an import-source base URL: http(s) only, no embedded credentials, and — for an
 *  IP-literal host (after WHATWG normalisation of decimal/hex/short forms) — not a blocked address. */
export function assertAllowedUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("invalid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("only http(s) URLs are allowed");
  if (u.username || u.password) throw new Error("credentials embedded in the URL are not allowed");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0 && isBlockedIp(host)) {
    throw new Error("the URL targets a blocked (loopback/link-local/metadata) address");
  }
  return u;
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/**
 * A `lookup` for http(s).request that resolves the host, rejects if ANY resolved address is blocked (closing
 * the DNS-rebinding gap where one record is public and another internal), and pins the connection to a
 * validated address. (IP-literal hosts never reach here — Node skips `lookup` for them — so they are blocked
 * up front by {@link assertAllowedUrl}.) Fails closed on resolve errors or empty results.
 */
export function guardedLookup(hostname: string, options: unknown, callback: LookupCb): void {
  dnsLookup(hostname, { all: true, verbatim: true }, (err, resolved) => {
    if (err) return callback(err, "", 0);
    const list = resolved as LookupAddress[];
    if (!list.length) return callback(new Error(`no DNS records for ${hostname}`), "", 0);
    for (const a of list) {
      if (isBlockedIp(a.address)) {
        return callback(new Error(`SSRF guard: ${hostname} resolves to blocked address ${a.address}`), "", 0);
      }
    }
    if (options && typeof options === "object" && (options as { all?: boolean }).all) {
      return (callback as unknown as (e: null, r: LookupAddress[]) => void)(null, list);
    }
    callback(null, list[0].address, list[0].family);
  });
}
