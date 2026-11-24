import type { ServerView } from "./types";

export type AddressKind = "public" | "private" | "other";

export interface AddressRow {
  ip: string;
  family: 4 | 6;
  kind: AddressKind;
  /** Where the hub got it, only for the two addresses it uses as the server's main IPs. */
  source: string | null;
  /** True for the address the hub currently uses as the server's IPv4 / IPv6 main IP. */
  main: boolean;
}

const isV6 = (ip: string) => ip.includes(":");

/** Rough client-side classification for display only (the hub is the authority and re-validates a pin). */
export function classifyIp(ip: string): AddressKind {
  if (isV6(ip)) {
    const v = ip.toLowerCase();
    if (v === "::1" || v === "::" || /^fe[89ab]/.test(v) || /^f[cd]/.test(v)) return "private";
    return "public";
  }
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return "other";
  const [a, b] = p;
  if (a === 10 || a === 127 || a === 0) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  if (a === 169 && b === 254) return "private";
  if (a === 100 && b >= 64 && b <= 127) return "private"; // CGNAT / Tailscale
  return "public";
}

type AddressSource = Pick<ServerView, "publicIp" | "publicIpv6" | "ipSource" | "reportedIps"> & Partial<Pick<ServerView, "ipv6Source">>;

/** Every address of a server: the two main ones first (IPv4, IPv6), then everything the host reported. Deduped. */
export function addressRows(s: AddressSource): AddressRow[] {
  const rows: AddressRow[] = [];
  const seen = new Set<string>();
  const push = (ip: string | null | undefined, source: string | null, main: boolean) => {
    if (!ip || seen.has(ip)) return;
    seen.add(ip);
    rows.push({ ip, family: isV6(ip) ? 6 : 4, kind: classifyIp(ip), source, main });
  };
  push(s.publicIp, s.ipSource, true);
  push(s.publicIpv6, s.ipv6Source ?? s.ipSource, true);
  for (const ip of s.reportedIps ?? []) push(ip, null, false);
  return rows;
}

/** i18n key for the human label of an address source. */
export function ipSourceKey(source: string | null | undefined): string {
  switch (source) {
    case "manual":
      return "servers.ipSourceManual";
    case "reported":
      return "servers.ipSourceInterface";
    case "metadata":
      return "servers.ipSourceMetadata";
    default:
      return "servers.ipSourceObserved";
  }
}
