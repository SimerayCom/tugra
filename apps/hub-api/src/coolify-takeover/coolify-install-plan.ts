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
  | "not_generated";

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

export interface ServerLink {
  teamId: string;
  serverId: string;
}

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

/** Does this Tugra server sit at the Coolify server's address? Compared on address, case-insensitively. */
export function sameHost(ip: string, s: { publicIp: string | null; publicIpv6: string | null; hostname: string | null; reportedIps: string[] }): boolean {
  const a = ip.trim().toLowerCase();
  if (!a) return false;
  return [s.publicIp, s.publicIpv6, s.hostname, ...s.reportedIps].some((x) => !!x && x.toLowerCase() === a);
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
