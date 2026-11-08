import type { ServerView, ServerStatus } from "./types";

export function statusCounts(
  servers: ServerView[],
): Record<ServerStatus, number> {
  const acc: Record<ServerStatus, number> = {
    ONLINE: 0,
    PENDING: 0,
    OFFLINE: 0,
  };
  for (const s of servers) acc[s.status]++;
  return acc;
}

/** Human team label for a fleet row; falls back to a short id when unknown. */
export function teamLabel(teams: { id: string; name: string }[], id: string): string {
  return teams.find((t) => t.id === id)?.name ?? id.slice(0, 6);
}

/** Filter the fleet to a single status (null = all). */
export function filterByStatus(servers: ServerView[], status: ServerStatus | null): ServerView[] {
  return status ? servers.filter((s) => s.status === status) : servers;
}

/** Case-insensitive substring filter over a server's name, hostname and public IP(s). Blank query = all. */
export function filterByText(servers: ServerView[], query: string): ServerView[] {
  const q = query.trim().toLowerCase();
  if (!q) return servers;
  return servers.filter((s) =>
    [s.name, s.hostname, s.publicIp, s.publicIpv6].some((v) => v != null && v.toLowerCase().includes(q)),
  );
}

export type ServerSortKey = "name" | "status" | "team" | "cpu" | "lastSeen";
export type SortDir = "asc" | "desc";

/** Numeric columns read best biggest/newest-first; text columns A→Z. */
export function defaultSortDir(key: ServerSortKey): SortDir {
  return key === "cpu" || key === "lastSeen" ? "desc" : "asc";
}

const STATUS_RANK: Record<ServerStatus, number> = { ONLINE: 0, PENDING: 1, OFFLINE: 2 };

/**
 * Stable sort of the fleet. Rows with no value for a numeric key (never seen, no samples) always sink to
 * the bottom regardless of direction. Ties keep their incoming order (explicit index tiebreak).
 */
export function sortServers(
  servers: ServerView[],
  key: ServerSortKey,
  dir: SortDir,
  ctx: { teams?: { id: string; name: string }[]; cpu?: (id: string) => number | null | undefined } = {},
): ServerView[] {
  const sign = dir === "asc" ? 1 : -1;
  const numeric = (s: ServerView): number | null => {
    if (key === "lastSeen") return s.lastSeenAt ? new Date(s.lastSeenAt).getTime() : null;
    if (key === "cpu") return ctx.cpu?.(s.id) ?? null;
    return null;
  };
  return servers
    .map((s, i) => ({ s, i }))
    .sort((a, b) => {
      let c = 0;
      if (key === "name") c = a.s.name.localeCompare(b.s.name, undefined, { sensitivity: "base", numeric: true }) * sign;
      else if (key === "team") c = teamLabel(ctx.teams ?? [], a.s.teamId).localeCompare(teamLabel(ctx.teams ?? [], b.s.teamId), undefined, { sensitivity: "base" }) * sign;
      else if (key === "status") c = (STATUS_RANK[a.s.status] - STATUS_RANK[b.s.status]) * sign;
      else {
        const x = numeric(a.s);
        const y = numeric(b.s);
        if (x == null || y == null) c = x == null && y == null ? 0 : x == null ? 1 : -1;
        else c = (x - y) * sign;
      }
      return c || a.i - b.i;
    })
    .map((x) => x.s);
}

export function groupByTeam(
  servers: ServerView[],
): Record<string, ServerView[]> {
  const out: Record<string, ServerView[]> = {};
  for (const s of servers) (out[s.teamId] ??= []).push(s);
  return out;
}

/** Of the selected items (servers or databases), only those the user may write to. */
export function writableIds<T extends { id: string; canWrite: boolean }>(
  items: T[],
  selected: Set<string>,
): string[] {
  return items
    .filter((s) => selected.has(s.id) && s.canWrite)
    .map((s) => s.id);
}

export function pct(used: number, total: number): number {
  return total > 0 ? Math.round((used / total) * 100) : 0;
}

export function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function fmtBytes(n: number): string {
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(1)} GB`;
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(0)} MB`;
  if (n >= 1 << 10) return `${(n / (1 << 10)).toFixed(0)} KB`;
  return `${n} B`;
}

/** Bytes from the API (BigInt serialized to string) → human size. */
export function fmtBytesStr(s: string | null): string {
  if (!s) return "—";
  const n = Number(s);
  return Number.isFinite(n) ? fmtBytes(n) : "—";
}

/** Seconds of uptime → compact "Nd Nh" / "Nh Nm" / "Nm". */
export function formatUptime(sec: number | null): string {
  if (sec == null || sec < 0) return "—";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
