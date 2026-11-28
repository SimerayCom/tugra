import { isIP } from "node:net";

/**
 * Hub-side literal-address classification for log-drain endpoints. This is a UX PRE-CHECK only: a hostname
 * resolves on the agent, so the agent's dial guard (checked on the RESOLVED ip) is authoritative. Pure and
 * dependency-free (hand-written CIDR math over bytes; no IP library).
 */
export type AddressClass =
  | "blocked" // metadata / link-local / unspecified / multicast: never allowed for any drain
  | "private" // loopback, RFC1918, CGNAT, ULA, localhost: only with allowPrivate
  | "public" // a public IP literal
  | "name"; // a hostname (resolved agent-side; not classifiable here)

/** Parse a dotted IPv4 into 4 bytes, or null. */
function v4Bytes(s: string): number[] | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

/** Parse an IPv6 literal (no brackets, no zone) into 16 bytes, or null. Handles `::` and an IPv4 suffix. */
export function v6Bytes(input: string): number[] | null {
  let s = input;
  if (isIP(s) !== 6) return null;
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(":");
  if (s.slice(lastColon + 1).includes(".")) {
    const v4 = v4Bytes(s.slice(lastColon + 1));
    if (!v4) return null;
    tail = v4;
    s = s.slice(0, lastColon + 1) + "0:0"; // placeholder groups, replaced below
  }
  const dbl = s.indexOf("::");
  const groups = (part: string): number[] => (part === "" ? [] : part.split(":").map((g) => parseInt(g, 16)));
  let head: number[];
  let rest: number[] = [];
  if (dbl >= 0) {
    head = groups(s.slice(0, dbl));
    rest = groups(s.slice(dbl + 2));
    const fill = 8 - head.length - rest.length;
    if (fill < 0) return null;
    head = [...head, ...new Array<number>(fill).fill(0), ...rest];
  } else {
    head = groups(s);
  }
  if (head.length !== 8 || head.some((g) => !Number.isFinite(g) || g < 0 || g > 0xffff)) return null;
  const bytes: number[] = [];
  for (const g of head) bytes.push(g >> 8, g & 0xff);
  if (tail.length === 4) {
    bytes[12] = tail[0];
    bytes[13] = tail[1];
    bytes[14] = tail[2];
    bytes[15] = tail[3];
  }
  return bytes;
}

function classifyV4(b: number[]): AddressClass {
  const [a, c] = b;
  if (a === 0) return "blocked"; // 0.0.0.0/8 ("this network", includes unspecified)
  if (a === 169 && c === 254) return "blocked"; // link-local incl. the 169.254.169.254 metadata endpoint
  if (a >= 224) return "blocked"; // multicast + reserved
  if (a === 127) return "private";
  if (a === 10) return "private";
  if (a === 172 && c >= 16 && c <= 31) return "private";
  if (a === 192 && c === 168) return "private";
  if (a === 100 && c >= 64 && c <= 127) return "private"; // CGNAT 100.64.0.0/10
  return "public";
}

function classifyV6(b: number[]): AddressClass {
  const allZero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  if (allZero(0, 16)) return "blocked"; // ::
  // IPv4-mapped ::ffff:a.b.c.d and NAT64 64:ff9b::a.b.c.d carry an IPv4 address: judge that
  if (allZero(0, 10) && b[10] === 0xff && b[11] === 0xff) return classifyV4(b.slice(12));
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && allZero(4, 12)) return classifyV4(b.slice(12));
  if (allZero(0, 15) && b[15] === 1) return "private"; // ::1
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return "blocked"; // fe80::/10 link-local
  if (b[0] === 0xff) return "blocked"; // multicast
  // fd00:ec2::254 (AWS IMDS over IPv6)
  if (b[0] === 0xfd && b[1] === 0x00 && b[2] === 0x0e && b[3] === 0xc2 && allZero(4, 14) && b[14] === 0x02 && b[15] === 0x54) return "blocked";
  if ((b[0] & 0xfe) === 0xfc) return "private"; // fc00::/7 ULA
  return "public";
}

/** Strip brackets / zone id / trailing dot and lowercase a host as parsed from an endpoint. */
export function normalizeHost(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  const zone = h.indexOf("%");
  if (zone >= 0) h = h.slice(0, zone);
  if (h.endsWith(".") && isIP(h.slice(0, -1)) === 0) h = h.slice(0, -1);
  return h;
}

/** Classify an endpoint host. Names are "name" except localhost and the well-known metadata hostname. */
export function classifyHost(host: string): AddressClass {
  const h = normalizeHost(host);
  if (h === "metadata.google.internal") return "blocked";
  if (h === "localhost" || h.endsWith(".localhost")) return "private";
  const kind = isIP(h);
  if (kind === 4) {
    const b = v4Bytes(h);
    return b ? classifyV4(b) : "name";
  }
  if (kind === 6) {
    const b = v6Bytes(h);
    return b ? classifyV6(b) : "blocked"; // an IPv6 literal we cannot parse is not trusted
  }
  return "name";
}

/**
 * Does this host mean "the machine I am on" (localhost, 127.0.0.0/8, ::1, an IPv4-mapped 127.x)? The forwarder runs inside the
 * agent's container, where that is the agent itself and never the server's own Loki, Vector or syslog: such an endpoint can only
 * be refused at configuration time with a message that says so, not left to fail on every delivery.
 */
export function isLoopbackHost(host: string): boolean {
  const h = normalizeHost(host);
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  const kind = isIP(h);
  if (kind === 4) {
    const b = v4Bytes(h);
    return !!b && b[0] === 127;
  }
  if (kind === 6) {
    const b = v6Bytes(h);
    if (!b) return false;
    const zeros = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
    if (zeros(0, 15) && b[15] === 1) return true; // ::1
    return zeros(0, 10) && b[10] === 0xff && b[11] === 0xff && b[12] === 127; // ::ffff:127.x.x.x
  }
  return false;
}
