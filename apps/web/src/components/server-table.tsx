"use client";

import Link from "next/link";
import { useGuardedPush } from "../hooks/useUnsavedChanges";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, ChevronUp, ChevronsUpDown, Power, RefreshCw, SearchX, Server, Terminal } from "lucide-react";
import type { ServerView, ServerStatus, FleetTrendRow } from "../lib/types";
import { MiniUsageBars } from "./mini-usage-bars";
import { CapabilityBadges } from "./capability-badges";
import { TeamChip } from "./team-chip";
import { latestTrendPoint } from "../lib/fleet-view";
import { agentVersionState } from "../lib/agent-version";
import { relativeTime, serverLiveness, clusterByTeam, statusCounts, writableIds, teamLabel, filterByStatus, filterByText, sortServers, defaultSortDir, type ServerSortKey, type SortDir } from "../lib/fleet";
import { clickedInteractive } from "../lib/row-nav";
import { useT } from "../i18n/provider";
import { Badge, Btn, EmptyState, StatusDot } from "./ui";
import { Select, TextInput } from "./form";
import { TagChips } from "./tags";
import { BulkRunModal } from "./bulk-run-modal";
import { CleanupBulkModal } from "./cleanup-bulk-modal";
import { PatchBulkModal } from "./patch-bulk-modal";
import { AgentUpdateBulkModal } from "./agent-update-bulk-modal";
import { CapabilitiesBulkModal } from "./capabilities-bulk-modal";
import { TeamMoveBulkModal } from "./team-move-bulk-modal";
import { serverDisplayName } from "../lib/server-name";

/** Rows per page by default, and the choices offered. Selection persists across pages; the header select-all acts on the visible page only. */
export const SERVER_PAGE_SIZE = 100;
export const SERVER_PAGE_SIZES = [25, 50, 100, 250] as const;

/** Newest CPU sample of a server's trend series (null when it has none) — the numeric key behind the usage sort. */
function latestCpu(row: FleetTrendRow | undefined): number | null {
  return latestTrendPoint(row)?.cpu ?? null;
}

const ALL_TEAMS = "__all__";

export function ServerTable({
  servers,
  teams = [],
  status = null,
  onStatusChange,
  trends,
  agentTarget,
  onUpdateAgent,
  updatingAgentIds,
  initialPageSize = SERVER_PAGE_SIZE,
}: {
  /** Recent CPU/RAM trend per server (one batch call) → the usage bars column; absent → "—" cells. */
  trends?: Map<string, FleetTrendRow>;
  servers: ServerView[];
  teams?: { id: string; name: string; iconUpdatedAt?: string | null }[];
  status?: ServerStatus | null;
  onStatusChange?: (s: ServerStatus | null) => void;
  /** The agent version the fleet should run (newest release / the hub's own). Absent → no "outdated" hint. */
  agentTarget?: string | null;
  /** Row quick action "Update agent". Absent → the action is not offered. */
  onUpdateAgent?: (server: ServerView) => void;
  /** Servers whose agent update request is in flight (their button is busy). */
  updatingAgentIds?: ReadonlySet<string>;
  /** Rows per page to start with (the user can change it). */
  initialPageSize?: number;
}) {
  const t = useT();
  const push = useGuardedPush();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showBulk, setShowBulk] = useState(false);
  const [showCleanup, setShowCleanup] = useState(false);
  const [showPatch, setShowPatch] = useState(false);
  const [showAgentUpdate, setShowAgentUpdate] = useState(false);
  const [showCaps, setShowCaps] = useState(false);
  const [showTeamMove, setShowTeamMove] = useState(false);
  const [query, setQuery] = useState("");
  const [teamFilter, setTeamFilter] = useState<string>(ALL_TEAMS);
  const [groupTeams, setGroupTeams] = useState(false);
  const [collapsedTeams, setCollapsedTeams] = useState<Set<string>>(new Set());
  const [pageSize, setPageSize] = useState<number>(initialPageSize);
  const [sort, setSort] = useState<{ key: ServerSortKey; dir: SortDir } | null>(null);
  const [page, setPage] = useState(0);
  const counts = useMemo(() => statusCounts(servers), [servers]);
  // Teams that actually have servers here → the team filter only appears when there is something to choose.
  const teamsInUse = useMemo(() => [...new Set(servers.map((x) => x.teamId))].map((id) => ({ id, name: teamLabel(teams, id) })).sort((x, y) => x.name.localeCompare(y.name)), [servers, teams]);
  // The team column and group headers only earn their space when there is more than one team to tell apart.
  const showTeamCol = teamsInUse.length > 1;
  const activeTeam = teamFilter !== ALL_TEAMS && teamsInUse.some((x) => x.id === teamFilter) ? teamFilter : ALL_TEAMS;
  // filter (status chip + team + text) → sort → group by team → page. Memoised so a keystroke only re-runs the cheap pure steps.
  const rows = useMemo(() => {
    const byTeam = activeTeam === ALL_TEAMS ? servers : servers.filter((x) => x.teamId === activeTeam);
    const filtered = filterByText(filterByStatus(byTeam, status), query);
    const sorted = sort
      ? sortServers(filtered, sort.key, sort.dir, { teams, cpu: (id) => latestCpu(trends?.get(id)) })
      : filtered;
    return groupTeams ? clusterByTeam(sorted, teams) : sorted;
  }, [servers, status, query, sort, teams, trends, activeTeam, groupTeams]);
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const curPage = Math.min(page, pageCount - 1);
  const pageRows = useMemo(
    () => rows.slice(curPage * pageSize, (curPage + 1) * pageSize),
    [rows, curPage, pageSize],
  );
  // A new filter always starts from the first page.
  useEffect(() => { setPage(0); }, [status, query, activeTeam, groupTeams, pageSize]);
  const pageWritable = pageRows.filter((r) => r.canWrite);
  const pageSelected = pageWritable.filter((r) => selected.has(r.id)).length;
  const allPageSelected = pageWritable.length > 0 && pageSelected === pageWritable.length;
  const selectAllRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = pageSelected > 0 && !allPageSelected;
  }, [pageSelected, allPageSelected]);
  const writable = writableIds(servers, selected);
  const skipped = selected.size - writable.length;

  const statusChip = (s: ServerStatus | null, label: string, color: string) => {
    const active = status === s;
    return (
      <button
        type="button"
        onClick={() => onStatusChange?.(s)}
        aria-pressed={active}
        style={{ fontFamily: "inherit", fontSize: 12, cursor: "pointer", border: "1px solid", borderColor: active ? color : "var(--c-bd)", background: active ? `color-mix(in srgb, ${color} 14%, transparent)` : "transparent", color, borderRadius: 999, padding: "3px 11px" }}
      >
        {label}
      </button>
    );
  };

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSort = (key: ServerSortKey) => {
    setSort((prev) => (prev?.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: defaultSortDir(key) }));
    setPage(0);
  };
  const toggleAllOnPage = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allPageSelected) for (const r of pageWritable) next.delete(r.id);
      else for (const r of pageWritable) next.add(r.id);
      return next;
    });
  };
  const ariaSort = (key: ServerSortKey): "ascending" | "descending" | "none" =>
    sort?.key === key ? (sort.dir === "asc" ? "ascending" : "descending") : "none";
  const sortBtn = (key: ServerSortKey, label: string, opts?: { secondary?: boolean }) => {
    const active = sort?.key === key;
    const Caret = sort?.key === key ? (sort.dir === "asc" ? ChevronUp : ChevronDown) : ChevronsUpDown;
    return (
      <button
        type="button"
        className="tg-row"
        data-sort-key={key}
        // A secondary control inside a shared <th> can't use the th's aria-sort, so it carries its own state.
        aria-pressed={opts?.secondary ? active : undefined}
        onClick={() => toggleSort(key)}
        style={{ fontFamily: "inherit", fontSize: "inherit", fontWeight: "inherit", color: sort?.key === key ? "var(--c-tx)" : "inherit", background: "transparent", border: "none", padding: "2px 4px", margin: "-2px -4px", borderRadius: 4, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 4 }}
      >
        {label}
        {opts?.secondary && active && sort && (
          <span className="sr-only"> {t(sort.dir === "asc" ? "servers.sortedAsc" : "servers.sortedDesc")}</span>
        )}
        <Caret size={12} aria-hidden style={{ opacity: sort?.key === key ? 1 : 0.5 }} />
      </button>
    );
  };
  // The clear button unmounts with the no-results state, so hand focus to the search box instead of body.
  const clearFilters = () => { setQuery(""); onStatusChange?.(null); searchRef.current?.focus(); };
  const pagerDisabledStyle: React.CSSProperties = { opacity: 0.5, cursor: "default" };

  const cell: React.CSSProperties = { padding: "10px 14px", fontSize: 13 };

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        {statusChip(null, t("servers.total", { n: servers.length }), "var(--c-tx3)")}
        {statusChip("ONLINE", `● ${t("servers.online", { n: counts.ONLINE })}`, "var(--c-g)")}
        {statusChip("PENDING", `● ${t("servers.pending", { n: counts.PENDING })}`, "var(--c-am)")}
        {statusChip("OFFLINE", `● ${t("servers.offline", { n: counts.OFFLINE })}`, "var(--c-r)")}
        {teamsInUse.length > 1 && (
          <>
            <Select
              ariaLabel={t("servers.filterTeam")}
              value={activeTeam}
              onChange={setTeamFilter}
              options={[{ value: ALL_TEAMS, label: t("servers.allTeams") }, ...teamsInUse.map((x) => ({ value: x.id, label: x.name }))]}
              style={{ width: "auto", minWidth: 130, fontSize: 12, padding: "4px 8px" }}
            />
            <button
              type="button"
              aria-pressed={groupTeams}
              onClick={() => setGroupTeams((g) => !g)}
              style={{ fontFamily: "inherit", fontSize: 12, cursor: "pointer", border: "1px solid", borderColor: groupTeams ? "var(--c-a)" : "var(--c-bd)", background: groupTeams ? "var(--c-ad)" : "transparent", color: groupTeams ? "var(--c-a)" : "var(--c-tx2)", borderRadius: 999, padding: "3px 11px" }}
            >
              {t("servers.groupByTeam")}
            </button>
          </>
        )}
        {servers.length > 0 && (
          <TextInput
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("servers.searchPlaceholder")}
            aria-label={t("servers.searchPlaceholder")}
            style={{ maxWidth: 240, marginLeft: "auto", padding: "4px 11px", fontSize: 12 }}
          />
        )}
      </div>

      {/* One vertical scroll area: the page. This wrapper only scrolls sideways (overflow-y hidden, height auto), so it can never become a second vertical scroller. */}
      <div className="tg-tablewrap" role="region" aria-label={t("servers.title")} tabIndex={0} style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r2)" }}>
        <table style={{ width: "100%", minWidth: 900, borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "var(--c-sb)", color: "var(--c-tx3)", textAlign: "left" }}>
              <th scope="col" style={{ ...cell, width: 36 }}>
                <input
                  ref={selectAllRef}
                  type="checkbox"
                  aria-label={t("servers.selectAll")}
                  checked={allPageSelected}
                  disabled={pageWritable.length === 0}
                  onChange={toggleAllOnPage}
                />
              </th>
              <th scope="col" style={cell} aria-sort={ariaSort("name")}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 14 }}>
                  {sortBtn("name", t("servers.server"))}
                  {sortBtn("status", t("servers.status"), { secondary: true })}
                </span>
              </th>
              {showTeamCol && <th scope="col" style={cell} aria-sort={ariaSort("team")}>{sortBtn("team", t("servers.team"))}</th>}
              <th scope="col" style={cell} aria-sort={ariaSort("cpu")}>{sortBtn("cpu", t("servers.colTrend"))}</th>
              <th scope="col" style={cell}>{t("servers.access")}</th>
              <th scope="col" style={cell} aria-sort={ariaSort("lastSeen")}>{sortBtn("lastSeen", t("servers.lastSeen"))}</th>
              <th scope="col" style={{ ...cell, width: 150 }}><span className="sr-only">{t("servers.rowActions")}</span></th>
            </tr>
          </thead>
          <tbody>
            {pageRows.map((s, i) => {
              const live = serverLiveness(s.status, s.lastSeenAt);
              const team = teams.find((x) => x.id === s.teamId);
              const newGroup = groupTeams && (i === 0 || pageRows[i - 1].teamId !== s.teamId);
              const hidden = groupTeams && collapsedTeams.has(s.teamId);
              const verState = agentVersionState(s.agentVersion, agentTarget);
              const updating = updatingAgentIds?.has(s.id) ?? false;
              const canAct = s.canWrite;
              const canTerminal = canAct && s.status === "ONLINE" && (s.capabilities ?? []).includes("terminal");
              const canUpdate = canAct && !!onUpdateAgent && s.status === "ONLINE" && (s.capabilities ?? []).includes("deploy");
              return (
                <Fragment key={s.id}>
                  {newGroup && (
                    <tr data-testid="team-group-row" style={{ background: "var(--c-sb)" }}>
                      <th scope="rowgroup" colSpan={showTeamCol ? 7 : 6} style={{ ...cell, padding: "2px 14px", textAlign: "left", borderTop: "1px solid var(--c-bd)" }}>
                        <button
                          type="button"
                          aria-expanded={!hidden}
                          onClick={() => setCollapsedTeams((c) => { const n = new Set(c); if (n.has(s.teamId)) n.delete(s.teamId); else n.add(s.teamId); return n; })}
                          style={{ display: "inline-flex", alignItems: "center", gap: 10, minHeight: 44, background: "transparent", border: "none", padding: 0, fontFamily: "inherit", color: "inherit", cursor: "pointer" }}
                        >
                          {hidden ? <ChevronRight size={16} aria-hidden /> : <ChevronDown size={16} aria-hidden />}
                          <TeamChip team={team} fallbackName={teamLabel(teams, s.teamId)} />
                          <span style={{ fontSize: 11, color: "var(--c-tx3)", fontWeight: 400 }}>
                            {t("servers.groupCount", { n: rows.filter((r) => r.teamId === s.teamId).length })}
                          </span>
                        </button>
                      </th>
                    </tr>
                  )}
                  {!hidden && (
                  <tr
                    className="row-link"
                    onClick={(e) => { if (!clickedInteractive(e)) push(`/servers/${s.id}`); }}
                    style={{ borderTop: "1px solid var(--c-bd)", opacity: s.canWrite ? 1 : 0.6 }}
                  >
                    <td style={cell}>
                      <input type="checkbox" disabled={!s.canWrite} checked={selected.has(s.id)} onChange={() => toggle(s.id)} aria-label={t("servers.selectRow", { name: serverDisplayName(s, t) })} title={s.canWrite ? "" : t("servers.readonly")} />
                    </td>
                    <td style={cell}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <StatusDot status={s.status} stale={live === "stale"} />
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 600, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                            <Link href={`/servers/${s.id}`} style={{ color: "var(--c-tx)", textDecoration: "none" }}>{serverDisplayName(s, t)}</Link>
                            <TagChips tags={s.tags} />
                          </div>
                          <div className="mono" style={{ fontSize: 11, color: "var(--c-tx3)" }}>
                            {s.hostname ?? "—"}
                            {s.agentVersion && (
                              <span data-agent-state={verState} title={verState === "outdated" && agentTarget ? t("servers.agentOutdated", { from: s.agentVersion, to: agentTarget }) : verState === "current" ? t("servers.agentCurrent") : undefined} style={{ marginLeft: 8, color: verState === "outdated" ? "var(--c-am)" : verState === "current" ? "var(--c-g)" : "var(--c-tx3)" }}>
                                {s.agentVersion}
                                {verState === "outdated" && <span className="sr-only"> — {t("servers.agentUpdateAvailable")}</span>}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    </td>
                    {showTeamCol && (
                      <td style={cell}>
                        <TeamChip team={team} fallbackName={teamLabel(teams, s.teamId)} />
                      </td>
                    )}
                    <td style={cell}>
                      <MiniUsageBars row={trends?.get(s.id)} cpuLabel={t("servers.trendCpuNow")} memLabel={t("servers.trendMemNow")} cpuShort={t("servers.miniCpu")} memShort={t("servers.miniRam")} noDataLabel={t("servers.noRecentData")} />
                    </td>
                    <td style={cell}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <CapabilityBadges capabilities={s.capabilities} />
                        {!s.canWrite && <Badge tone="muted">{t("servers.readOnly")}</Badge>}
                      </div>
                    </td>
                    <td style={{ ...cell, color: "var(--c-tx3)" }} title={s.lastSeenAt ?? undefined}>{relativeTime(s.lastSeenAt, t)}</td>
                    <td style={cell}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 4 }}>
                        {canAct && (
                          <>
                            <ActionLink href={`/servers/${s.id}?tab=shell`} icon={Terminal} label={t("servers.quickTerminal")} disabled={!canTerminal} disabledLabel={canAct && s.status !== "ONLINE" ? t("servers.quickTerminalOffline") : t("servers.quickTerminalOff")} />
                            {onUpdateAgent && (
                              <ActionButton icon={RefreshCw} label={t("servers.quickUpdateAgent")} disabled={!canUpdate || updating} tone={verState === "outdated" ? "warn" : "plain"} busy={updating} onClick={() => onUpdateAgent(s)} />
                            )}
                            <ActionLink href={`/servers/${s.id}?tab=maintenance`} icon={Power} label={t("servers.quickRestart")} disabled={false} disabledLabel="" />
                          </>
                        )}
                        <Link href={`/servers/${s.id}`} style={{ color: "var(--c-lapis)", fontSize: 12, textDecoration: "none", padding: "0 4px" }}>{t("servers.view")}</Link>
                      </div>
                    </td>
                  </tr>
                  )}
                </Fragment>
              );
            })}
            {servers.length === 0 && (
              <tr>
                <td colSpan={7} style={{ ...cell, padding: 0 }}>
                  <EmptyState
                    icon={Server}
                    title={t("servers.emptyTitle")}
                    action={<Link href="/servers/new"><Btn>{t("servers.emptyAdd")}</Btn></Link>}
                  >
                    {t("servers.empty")}
                  </EmptyState>
                </td>
              </tr>
            )}
            {servers.length > 0 && rows.length === 0 && (
              <tr>
                <td colSpan={7} style={{ ...cell, padding: 0 }}>
                  <EmptyState
                    icon={SearchX}
                    title={t("common.noResults")}
                    action={<Btn variant="ghost" onClick={clearFilters}>{t("common.clearFilters")}</Btn>}
                  >
                    {t("common.noResultsHint")}
                  </EmptyState>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <span className="sr-only" role="status" aria-live="polite">
        {t("servers.matchCount", { n: rows.length, m: servers.length })}
      </span>

      {rows.length > SERVER_PAGE_SIZES[0] && (
        <nav aria-label={t("servers.pager")} style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", flexWrap: "wrap", gap: 10, marginTop: 12, fontSize: 12, color: "var(--c-tx3)" }}>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            {t("servers.perPage")}
            <Select
              ariaLabel={t("servers.perPage")}
              value={String(pageSize)}
              onChange={(v) => setPageSize(Number(v))}
              options={SERVER_PAGE_SIZES.map((n) => ({ value: String(n), label: String(n) }))}
              style={{ width: "auto", fontSize: 12, padding: "3px 8px" }}
            />
          </label>
          <span role="status" aria-live="polite">
            {t("servers.pageRange", { from: curPage * pageSize + 1, to: Math.min(rows.length, (curPage + 1) * pageSize), total: rows.length })}
          </span>
          <Btn variant="ghost" onClick={() => { if (curPage > 0) setPage(curPage - 1); }} aria-disabled={curPage === 0 ? true : undefined} style={curPage === 0 ? pagerDisabledStyle : undefined} aria-label={t("servers.prevPage")}>{t("servers.prev")}</Btn>
          <span aria-current="page">{t("servers.pageOf", { page: curPage + 1, pages: pageCount })}</span>
          <Btn variant="ghost" onClick={() => { if (curPage < pageCount - 1) setPage(curPage + 1); }} aria-disabled={curPage >= pageCount - 1 ? true : undefined} style={curPage >= pageCount - 1 ? pagerDisabledStyle : undefined} aria-label={t("servers.nextPage")}>{t("servers.next")}</Btn>
        </nav>
      )}

      {selected.size > 0 && (
        <div style={{ position: "sticky", bottom: 16, marginTop: 16, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, padding: "10px 16px", background: "var(--c-sb)", border: "1px solid var(--c-a)", borderRadius: "var(--r2)", boxShadow: "0 10px 30px rgba(0,0,0,0.4)" }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>
            {t("servers.selected", { n: writable.length })}
            {skipped > 0 && <span style={{ color: "var(--c-tx3)", fontWeight: 400 }}> {t("servers.skipped", { n: skipped })}</span>}
          </span>
          <div style={{ flex: 1 }} />
          <Btn variant="ghost" onClick={() => setShowTeamMove(true)} disabled={writable.length === 0}>
            {t("servers.teamMoveBulk.open")}
          </Btn>
          <Btn variant="ghost" onClick={() => setShowCaps(true)} disabled={writable.length === 0}>
            {t("servers.bulkCaps.open")}
          </Btn>
          <Btn variant="ghost" onClick={() => setShowPatch(true)} disabled={writable.length === 0}>
            {t("bulk.applyPatch")}
          </Btn>
          <Btn variant="ghost" onClick={() => setShowAgentUpdate(true)} disabled={writable.length === 0}>
            {t("bulk.applyAgentUpdate")}
          </Btn>
          <Btn variant="ghost" onClick={() => setShowCleanup(true)} disabled={writable.length === 0}>
            {t("bulk.applyCleanup")}
          </Btn>
          <Btn onClick={() => setShowBulk(true)} disabled={writable.length === 0}>
            {t("bulk.runCommand")}
          </Btn>
        </div>
      )}

      {showBulk && (
        <BulkRunModal servers={servers} selectedIds={[...selected]} onClose={() => setShowBulk(false)} />
      )}
      {showCleanup && (
        <CleanupBulkModal servers={servers} selectedIds={[...selected]} onClose={() => setShowCleanup(false)} />
      )}
      {showPatch && (
        <PatchBulkModal servers={servers} selectedIds={[...selected]} onClose={() => setShowPatch(false)} />
      )}
      {showCaps && (
        <CapabilitiesBulkModal servers={servers} selectedIds={[...selected]} onClose={() => setShowCaps(false)} />
      )}
      {showTeamMove && (
        <TeamMoveBulkModal servers={servers} selectedIds={[...selected]} onClose={() => setShowTeamMove(false)} />
      )}
      {showAgentUpdate && (
        <AgentUpdateBulkModal servers={servers} selectedIds={[...selected]} onClose={() => setShowAgentUpdate(false)} />
      )}
    </div>
  );
}

const actionStyle = (disabled: boolean, tone: "plain" | "warn" = "plain"): React.CSSProperties => ({
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 30,
  height: 30,
  borderRadius: 6,
  border: "1px solid transparent",
  background: tone === "warn" && !disabled ? "color-mix(in srgb, var(--c-am) 15%, transparent)" : "transparent",
  color: disabled ? "var(--c-tx3)" : tone === "warn" ? "var(--c-am)" : "var(--c-tx2)",
  opacity: disabled ? 0.45 : 1,
  cursor: disabled ? "not-allowed" : "pointer",
  padding: 0,
});

/** Icon link quick action. A disabled one stays in the row (so the layout is stable) but is inert and says why. */
function ActionLink({ href, icon: Icon, label, disabled, disabledLabel }: { href: string; icon: typeof Terminal; label: string; disabled: boolean; disabledLabel: string }) {
  if (disabled) {
    return (
      <span role="img" aria-label={disabledLabel} title={disabledLabel} style={actionStyle(true)}>
        <Icon size={15} aria-hidden="true" />
      </span>
    );
  }
  return (
    <Link href={href} aria-label={label} title={label} className="tg-row" style={actionStyle(false)}>
      <Icon size={15} aria-hidden="true" />
    </Link>
  );
}

function ActionButton({ icon: Icon, label, disabled, busy, tone, onClick }: { icon: typeof Terminal; label: string; disabled: boolean; busy: boolean; tone: "plain" | "warn"; onClick: () => void }) {
  return (
    <button type="button" aria-label={label} title={label} aria-busy={busy || undefined} disabled={disabled} className="tg-row" onClick={onClick} style={actionStyle(disabled, tone)}>
      <Icon size={15} aria-hidden="true" />
    </button>
  );
}
