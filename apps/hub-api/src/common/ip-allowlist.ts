import { isIP } from "node:net";
import { normalizeIp } from "./observed-ip";

/**
 * Match a client IP against an allowlist of single IPs and/or CIDR ranges (IPv4 + IPv6), dependency-free.
 * Every address is parsed into a fixed-width BigInt and compared by prefix bits, so a client only matches
 * a CIDR of the SAME family. IPv4-mapped IPv6 (::ffff:a.b.c.d) is folded to its IPv4 (via normalizeIp) so
 * a mapped client and a plain-IPv4 allowlist entry compare in the same space. A malformed allowlist entry
 * is SKIPPED (never matches, never throws) — a bad entry can never turn into an accidental match-all.
 */

interface Addr {
  version: 4 | 6;
  bits: bigint;
}

function ipv4ToBig(ip: string): bigint | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let bits = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    bits = (bits << 8n) | BigInt(n);
  }
  return bits;
}

/** Rewrite a trailing embedded IPv4 (e.g. 64:ff9b::1.2.3.4) into two hex groups so the rest is pure hex. */
function foldEmbeddedV4(ip: string): string | null {
  const dot = ip.indexOf(".");
  if (dot === -1) return ip;
  const cut = ip.lastIndexOf(":", dot);
  if (cut === -1) return null;
  const v4 = ipv4ToBig(ip.slice(cut + 1));
  if (v4 === null) return null;
  const h1 = (v4 >> 16n).toString(16);
  const h2 = (v4 & 0xffffn).toString(16);
  return `${ip.slice(0, cut + 1)}${h1}:${h2}`;
}

function ipv6ToBig(ip0: string): bigint | null {
  const ip = foldEmbeddedV4(ip0);
  if (ip === null) return null;
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null; // no "::" → must be full 8
  const groups = [...head, ...Array<string>(Math.max(missing, 0)).fill("0"), ...tail];
  if (groups.length !== 8) return null;
  let bits = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    bits = (bits << 16n) | BigInt(parseInt(g, 16));
  }
  return bits;
}

/** Parse an IP literal into a family-tagged BigInt, or null if it isn't a valid IP. */
export function ipToBig(ip: string): Addr | null {
  const norm = normalizeIp(ip.trim());
  const v = isIP(norm);
  if (v === 4) {
    const bits = ipv4ToBig(norm);
    return bits === null ? null : { version: 4, bits };
  }
  if (v === 6) {
    const bits = ipv6ToBig(norm);
    return bits === null ? null : { version: 6, bits };
  }
  return null;
}

/** Is `entry` a valid single IP or `addr/prefix` CIDR? (Used to validate an owner-supplied allowlist.) */
export function isValidIpOrCidr(entry: string): boolean {
  const s = entry.trim();
  if (!s) return false;
  const slash = s.indexOf("/");
  if (slash === -1) return isIP(normalizeIp(s)) !== 0;
  const v = isIP(normalizeIp(s.slice(0, slash)));
  const prefixStr = s.slice(slash + 1);
  if (v === 0 || !/^\d{1,3}$/.test(prefixStr)) return false;
  const prefix = Number(prefixStr);
  return prefix >= 0 && prefix <= (v === 4 ? 32 : 128);
}

/** True if `clientIp` matches any allowlist entry (single IP or CIDR). Malformed entries are skipped. */
export function ipMatchesAllowlist(clientIp: string, allowlist: readonly string[]): boolean {
  const client = ipToBig(clientIp);
  if (!client) return false;
  for (const raw of allowlist) {
    const entry = raw.trim();
    if (!entry) continue;
    const slash = entry.indexOf("/");
    if (slash === -1) {
      const e = ipToBig(entry);
      if (e && e.version === client.version && e.bits === client.bits) return true;
      continue;
    }
    const net = ipToBig(entry.slice(0, slash));
    const prefixStr = entry.slice(slash + 1);
    if (!net || net.version !== client.version || !/^\d{1,3}$/.test(prefixStr)) continue;
    const size = client.version === 4 ? 32 : 128;
    const prefix = Number(prefixStr);
    if (prefix < 0 || prefix > size) continue;
    const shift = BigInt(size - prefix);
    if (client.bits >> shift === net.bits >> shift) return true;
  }
  return false;
}
