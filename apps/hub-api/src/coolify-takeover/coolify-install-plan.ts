import type { CoolifyServerLink } from "@tugra/shared";
import type { InvServer } from "./coolify-inventory";

/**
 * "Add all Coolify servers": from the inventory, one checklist row per Coolify server. Nothing here runs anything: a row is
 * either a command for the user to paste on that host, or a note that the server is already covered.
 */

export type ChecklistState =
  /** The Coolify host itself: the agent already runs here. */
  | "this_server"
  /** Matched an existing Tugra server (by address) that is already connected. */
  | "already_added"
  /** A Tugra server was created for it and waits for its agent: `installCommand` is the line to paste. */
  | "waiting"
  /** The pending server's command expired; reissue it. */
  | "expired"
  /** Waiting for its agent, but the caller cannot manage that server's team, so no command is shown. */
  | "no_access"
  /** Not generated yet: the user picks a team and generates. */
  | "not_generated"
  /** More than one Tugra server sits at its address: nothing is matched or created, the user picks the server themselves. */
  | "ambiguous";

export interface ChecklistRow {
  coolifyServerId: string;
  name: string;
  ip: string;
  port: number;
  user: string;
  state: ChecklistState;
  teamId: string | null;
  tugraServerId: string | null;
  installCommand: string | null;
  expiresAt: string | null;
  /** `ssh -p 22 root@203.0.113.7`: where to run the command. Display only. */
  ssh: string;
}

/** One `CoolifyInventory.serverLinks` entry. `linkedBy` and `evidence` are lane D's additive fields: a row written before them reads as a user link. */
export type ServerLink = CoolifyServerLink;

/** Only characters a host name or address can have reach the display line. */
const SAFE_HOST_RE = /^[A-Za-z0-9._:-]{1,255}$/;
const SAFE_USER_RE = /^[A-Za-z0-9._-]{1,64}$/;

export function sshHint(s: Pick<InvServer, "ip" | "port" | "user">): string {
  const host = SAFE_HOST_RE.test(s.ip) ? s.ip : "<host>";
  const user = SAFE_USER_RE.test(s.user) ? s.user : "root";
  const port = Number.isInteger(s.port) && s.port > 0 && s.port < 65536 ? s.port : 22;
  return `ssh${port === 22 ? "" : ` -p ${port}`} ${user}@${host.includes(":") ? `[${host}]` : host}`;
}

/** Unique, non-empty names for the servers to create (a team keeps one name per server). Pure; order preserved. */
export function uniqueNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((raw) => {
    const base = raw.trim().slice(0, 100) || "Server";
    let n = base;
    for (let i = 2; used.has(n.toLowerCase()); i++) n = `${base} (${i})`;
    used.add(n.toLowerCase());
    return n;
  });
}

/** Expand an IPv6 literal to eight lower-case hextets (`2001:0db8:0:0:0:0:0:1`), or null when it is not one. IPv4-mapped forms give the IPv4 text. */
function canonicalIpv6(raw: string): string | null {
  let a = raw.replace(/%.*$/, "");
  if (!/^[0-9a-f:.]+$/.test(a) || !a.includes(":")) return null;
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (tail) {
    const o = tail[1].split(".").map(Number);
    if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    a = a.slice(0, a.length - tail[1].length) + ((o[0] << 8) | o[1]).toString(16) + ":" + ((o[2] << 8) | o[3]).toString(16);
  }
  const halves = a.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8) || (halves.length === 2 && fill < 1)) return null;
  const groups = [...head, ...Array(fill).fill("0"), ...rest];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  const n = groups.map((g) => parseInt(g, 16));
  if (n[0] === 0 && n[1] === 0 && n[2] === 0 && n[3] === 0 && n[4] === 0 && n[5] === 0xffff) return `${n[6] >> 8}.${n[6] & 255}.${n[7] >> 8}.${n[7] & 255}`;
  return n.map((x) => x.toString(16)).join(":");
}

function parseIpv4(a: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((n) => n <= 255) ? o : null;
}

/** An address in one canonical form: IPv4 as written, IPv6 expanded, a host name lower-cased without its final dot. Null when empty. */
export function normalizeAddress(raw: string | null | undefined): string | null {
  const a = (raw ?? "").trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!a) return null;
  if (parseIpv4(a)) return a;
  return canonicalIpv6(a) ?? a;
}

/**
 * Can this address name one machine on the internet? False for loopback, private (RFC 1918), CGNAT / Tailscale (100.64/10),
 * link-local, unique-local (fc00::/7), multicast and the docker bridge ranges, which many machines share. Host names count when they
 * are a fully qualified name (a bare label such as `ubuntu` or `localhost` is not unique).
 */
export function isPublicAddress(raw: string | null | undefined): boolean {
  const a = normalizeAddress(raw);
  if (!a) return false;
  const v4 = parseIpv4(a);
  if (v4) {
    const [p, q] = v4;
    if (p === 0 || p === 10 || p === 127 || p >= 224) return false;
    if (p === 100 && q >= 64 && q <= 127) return false;
    if (p === 169 && q === 254) return false;
    if (p === 172 && q >= 16 && q <= 31) return false;
    if (p === 192 && q === 168) return false;
    if (p === 198 && (q === 18 || q === 19)) return false;
    return true;
  }
  if (a.includes(":")) {
    const first = parseInt(a.split(":")[0], 16);
    if (a === "0:0:0:0:0:0:0:0" || a === "0:0:0:0:0:0:0:1") return false;
    if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00) return false;
    return true;
  }
  return a.includes(".") && /^[a-z0-9.-]+$/.test(a) && a !== "localhost" && !a.endsWith(".local") && !a.endsWith(".localhost") && !a.endsWith(".internal");
}

/**
 * Does this Tugra server sit at the Coolify server's address? Only public addresses count (a private, CGNAT, Tailscale or docker
 * address is shared by many machines), IPv6 is compared in its expanded form, and host names are compared without case.
 */
export function sameHost(ip: string, s: { publicIp: string | null; publicIpv6: string | null; hostname: string | null; reportedIps: string[] }): boolean {
  const a = normalizeAddress(ip);
  if (!a || !isPublicAddress(a)) return false;
  return [s.publicIp, s.publicIpv6, s.hostname, ...s.reportedIps].some((x) => normalizeAddress(x) === a);
}

/**
 * The one Tugra server at an address: `match` when exactly one server sits there, `ambiguous` when several do (two teams that each
 * added the machine, say) so nothing is picked for the user, and neither when none does.
 */
export function findHostMatch<T extends { publicIp: string | null; publicIpv6: string | null; hostname: string | null; reportedIps: string[] }>(
  ip: string,
  known: readonly T[],
): { match: T | null; ambiguous: boolean } {
  const hits = known.filter((k) => sameHost(ip, k));
  return hits.length === 1 ? { match: hits[0], ambiguous: false } : { match: null, ambiguous: hits.length > 1 };
}

/** A stable, default team for each Coolify server: the Tugra team whose name equals the Coolify team's, else the fallback. */
export function defaultTeamFor(
  coolifyTeamId: string | null,
  coolifyTeams: Array<{ id: string; name: string }>,
  tugraTeams: Array<{ id: string; name: string }>,
  fallbackTeamId: string,
): string {
  const t = coolifyTeams.find((x) => x.id === coolifyTeamId);
  const match = t ? tugraTeams.find((x) => x.name.trim().toLowerCase() === t.name.trim().toLowerCase()) : undefined;
  return match?.id ?? fallbackTeamId;
}
