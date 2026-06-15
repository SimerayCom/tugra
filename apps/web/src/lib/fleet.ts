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

export function groupByTeam(
  servers: ServerView[],
): Record<string, ServerView[]> {
  const out: Record<string, ServerView[]> = {};
  for (const s of servers) (out[s.teamId] ??= []).push(s);
  return out;
}

/** Of the selected servers, only those the user may write to (bulk-eligible). */
export function writableIds(
  servers: ServerView[],
  selected: Set<string>,
): string[] {
  return servers
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
