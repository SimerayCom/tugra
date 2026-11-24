import type { LauncherTile } from "./launcher";
import type { Database, MetricsSample, ServerStatus } from "./types";
import type { UiMode } from "./ui-mode";

// Pure logic behind the Home launcher's fleet awareness: how big is this install, what does a mode switch
// hide, how are tiles grouped, and what the at-a-glance widgets show. No React, no storage — unit-tested.

/** Size of the install, as counts. Drives the "Fleet suits you better" hint and the mode-switch warning. */
export interface HomeScale {
  servers: number;
  teams: number;
  apps: number;
}

/** Count servers/teams/apps. The team count is the larger of the team list and the distinct teams the
 *  servers/apps belong to, so it still works while the team list is loading or hidden by permissions. */
export function homeScale(
  servers: { teamId: string }[],
  teams: { id: string }[],
  apps: { teamId: string }[],
): HomeScale {
  const ids = new Set<string>(teams.map((t) => t.id));
  for (const s of servers) ids.add(s.teamId);
  for (const a of apps) ids.add(a.teamId);
  return { servers: servers.length, teams: Math.max(teams.length, ids.size), apps: apps.length };
}

/** More than one server or team: Home (built for a single box) stops being the best fit. */
export function suggestFleet(scale: HomeScale): boolean {
  return scale.servers > 1 || scale.teams > 1;
}

/** What switching to `to` costs the user. Only the move to Home hides things, and only on a bigger install. */
export interface ModeSwitchImpact {
  risky: boolean;
  hidden: ("servers" | "teams")[];
}

export function modeSwitchImpact(to: UiMode, scale: HomeScale): ModeSwitchImpact {
  if (to !== "home" || !suggestFleet(scale)) return { risky: false, hidden: [] };
  return { risky: true, hidden: ["servers", ...(scale.teams > 1 ? (["teams"] as const) : [])] };
}

// ── grouping ────────────────────────────────────────────────────────────────

export interface ProjectGroup {
  key: string;
  name: string | null;
  tiles: LauncherTile[];
}

export interface TeamGroup {
  key: string;
  teamId: string;
  teamName: string;
  projects: ProjectGroup[];
}

const byName = (a: string, b: string) => a.localeCompare(b);

/** Team → project grouping. Teams and projects sort by name (apps without a project last); tiles keep the
 *  incoming order inside a project. An unknown team name falls back to `fallbackName`. */
export function groupTilesByTeam(tiles: LauncherTile[], teamNames: Record<string, string>, fallbackName = ""): TeamGroup[] {
  const teams = new Map<string, Map<string, ProjectGroup>>();
  for (const tile of tiles) {
    let projects = teams.get(tile.teamId);
    if (!projects) teams.set(tile.teamId, (projects = new Map()));
    const pk = tile.projectId ?? "";
    let g = projects.get(pk);
    if (!g) projects.set(pk, (g = { key: `${tile.teamId}:${pk}`, name: tile.projectName, tiles: [] }));
    g.tiles.push(tile);
  }
  return [...teams.entries()]
    .map(([teamId, projects]): TeamGroup => ({
      key: teamId,
      teamId,
      teamName: teamNames[teamId] ?? fallbackName,
      projects: [...projects.values()].sort((a, b) => (a.name === null ? 1 : 0) - (b.name === null ? 1 : 0) || byName(a.name ?? "", b.name ?? "")),
    }))
    .sort((a, b) => byName(a.teamName, b.teamName) || byName(a.teamId, b.teamId));
}

// ── order & folders ─────────────────────────────────────────────────────────

/** Put tiles listed in `order` first (in that sequence); the rest keep their incoming order after them. */
export function applyOrder(tiles: LauncherTile[], order: string[]): LauncherTile[] {
  if (order.length === 0) return tiles;
  const rank = new Map(order.map((id, i) => [id, i]));
  const known = tiles.filter((t) => rank.has(t.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  return [...known, ...tiles.filter((t) => !rank.has(t.id))];
}

/** Move `id` so it lands where `targetId` is (drag-and-drop). Unknown ids leave the list untouched. */
export function moveBefore(ids: string[], id: string, targetId: string): string[] {
  if (id === targetId || !ids.includes(id) || !ids.includes(targetId)) return ids;
  const without = ids.filter((x) => x !== id);
  const at = without.indexOf(targetId);
  // Dragging forward drops AFTER the target (it takes the target's old slot); backward drops before it.
  const forward = ids.indexOf(id) < ids.indexOf(targetId);
  without.splice(forward ? at + 1 : at, 0, id);
  return without;
}

/** Keyboard/mobile alternative to dragging: shift one slot (-1 earlier, +1 later), clamped at the ends. */
export function moveBy(ids: string[], id: string, delta: -1 | 1): string[] {
  const i = ids.indexOf(id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= ids.length) return ids;
  const next = [...ids];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

export interface HomeFolder {
  id: string;
  name: string;
  tileIds: string[];
}

export interface FolderGroup {
  key: string;
  folder: HomeFolder | null; // null = the "everything else" bucket
  tiles: LauncherTile[];
}

/** Folder view: one group per folder (only tiles that still exist; empty folders stay so they can be filled),
 *  then the unfiled tiles. The unfiled bucket is omitted when empty. */
export function groupTilesByFolder(tiles: LauncherTile[], folders: HomeFolder[]): FolderGroup[] {
  const byId = new Map(tiles.map((t) => [t.id, t]));
  const filed = new Set<string>();
  const groups: FolderGroup[] = folders.map((f) => {
    const own = f.tileIds.filter((id) => byId.has(id) && !filed.has(id));
    own.forEach((id) => filed.add(id));
    return { key: f.id, folder: f, tiles: own.map((id) => byId.get(id)!) };
  });
  const rest = tiles.filter((t) => !filed.has(t.id));
  if (rest.length > 0 || groups.length === 0) groups.push({ key: "__rest__", folder: null, tiles: rest });
  return groups;
}

/** File a tile into a folder (or `null` = take it out of every folder). A tile lives in at most one folder. */
export function assignToFolder(folders: HomeFolder[], tileId: string, folderId: string | null): HomeFolder[] {
  return folders.map((f) => {
    const without = f.tileIds.filter((id) => id !== tileId);
    return f.id === folderId ? { ...f, tileIds: [...without, tileId] } : { ...f, tileIds: without };
  });
}

export function folderOf(folders: HomeFolder[], tileId: string): string | null {
  return folders.find((f) => f.tileIds.includes(tileId))?.id ?? null;
}

// ── widgets ─────────────────────────────────────────────────────────────────

export interface ServerStatusSummary {
  total: number;
  online: number;
  offline: number;
  pending: number;
}

export function serverStatusSummary(servers: { status: ServerStatus }[]): ServerStatusSummary {
  const s: ServerStatusSummary = { total: servers.length, online: 0, offline: 0, pending: 0 };
  for (const x of servers) {
    if (x.status === "ONLINE") s.online++;
    else if (x.status === "OFFLINE") s.offline++;
    else s.pending++;
  }
  return s;
}

const fin = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** Disk usage of one host sample; null while the agent has not reported a usable disk. */
export function storageSummary(sample: Pick<MetricsSample, "diskUsed" | "diskTotal"> | undefined | null): { used: number; total: number; pct: number } | null {
  if (!sample || !fin(sample.diskUsed) || !fin(sample.diskTotal) || sample.diskTotal <= 0) return null;
  return { used: sample.diskUsed, total: sample.diskTotal, pct: Math.min(100, Math.max(0, (sample.diskUsed / sample.diskTotal) * 100)) };
}

export interface BackupSummary {
  total: number; // databases that can be backed up at all
  protected: number; // with scheduled backups on
  unprotected: number;
}

export function backupSummary(databases: Pick<Database, "backupSupported" | "backupEnabled">[]): BackupSummary {
  const eligible = databases.filter((d) => d.backupSupported);
  const on = eligible.filter((d) => d.backupEnabled).length;
  return { total: eligible.length, protected: on, unprotected: eligible.length - on };
}

/** Uptime split into the two largest meaningful units, for "3d 4h" / "5h 12m" / "8m". null when unknown. */
export function uptimeParts(seconds: number | null | undefined): { days: number; hours: number; minutes: number } | null {
  if (!fin(seconds) || seconds < 0) return null;
  const m = Math.floor(seconds / 60);
  return { days: Math.floor(m / 1440), hours: Math.floor((m % 1440) / 60), minutes: m % 60 };
}

/** Which server the gauges/widgets show. Honors the user's pick while that server still exists, otherwise the
 *  box the hub runs on, otherwise the first online one, otherwise the first. null with no servers at all. */
export function pickGaugeServer<S extends { id: string; isLocal: boolean; status: ServerStatus }>(servers: S[], preferredId: string | null): S | null {
  if (servers.length === 0) return null;
  return (
    servers.find((s) => s.id === preferredId) ??
    servers.find((s) => s.isLocal) ??
    servers.find((s) => s.status === "ONLINE") ??
    servers[0]
  );
}

// ── copy helpers ────────────────────────────────────────────────────────────

type Tr = (key: string, vars?: Record<string, string | number>) => string;

/** "1 server" / "27 servers" from `<base>_one` / `<base>_other` message keys. */
export function countLabel(t: Tr, base: "home.count_servers" | "home.count_teams", n: number): string {
  return t(`${base}_${n === 1 ? "one" : "other"}`, { n });
}

/** The two-sentence body of the Fleet → Home confirmation, with the user's own counts. */
export function modeSwitchBody(t: Tr, scale: HomeScale): string {
  const servers = countLabel(t, "home.count_servers", scale.servers);
  if (scale.teams > 1) return t("settings.uiModeConfirmBodyTeams", { servers, teams: countLabel(t, "home.count_teams", scale.teams) });
  return t("settings.uiModeConfirmBodyServers", { servers });
}
