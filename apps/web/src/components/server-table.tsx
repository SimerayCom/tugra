"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, ChevronsUpDown, SearchX, Server } from "lucide-react";
import type { ServerView, ServerStatus, FleetTrendRow } from "../lib/types";
import { TrendCell } from "./trend-cell";
import { relativeTime, statusCounts, writableIds, teamLabel, filterByStatus, filterByText, sortServers, defaultSortDir, type ServerSortKey, type SortDir } from "../lib/fleet";
import { clickedInteractive } from "../lib/row-nav";
import { useT } from "../i18n/provider";
import { Badge, Btn, EmptyState, StatusDot } from "./ui";
import { TextInput } from "./form";
import { TagChips } from "./tags";
import { BulkRunModal } from "./bulk-run-modal";
import { CleanupBulkModal } from "./cleanup-bulk-modal";
import { PatchBulkModal } from "./patch-bulk-modal";
import { AgentUpdateBulkModal } from "./agent-update-bulk-modal";

const TEAM_COLORS = ["#C9A84C", "#3D6FE5", "#2FBF71", "#E5484D", "#A855F7", "#F5A524"];
/** Rows per page. Selection persists across pages; the header select-all acts on the visible page only. */
export const SERVER_PAGE_SIZE = 25;

/** Newest CPU sample of a server's trend series (null when it has none) — the numeric key behind the Trend sort. */
function latestCpu(row: FleetTrendRow | undefined): number | null {
  const pts = row?.points;
  if (!pts || pts.length === 0) return null;
  return pts.reduce((a, b) => (b.ts >= a.ts ? b : a)).cpu;
}

function teamColor(teamId: string): string {
  let h = 0;
  for (const c of teamId) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return TEAM_COLORS[h % TEAM_COLORS.length];
}

export function ServerTable({
  servers,
  teams = [],
  status = null,
  onStatusChange,
  trends,
}: {
  /** Recent CPU/RAM trend per server (one batch call) → the sparkline column; absent → "—" cells. */
  trends?: Map<string, FleetTrendRow>;
  servers: ServerView[];
  teams?: { id: string; name: string }[];
  status?: ServerStatus | null;
  onStatusChange?: (s: ServerStatus | null) => void;
}) {
  const t = useT();
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showBulk, setShowBulk] = useState(false);
  const [showCleanup, setShowCleanup] = useState(false);
  const [showPatch, setShowPatch] = useState(false);
  const [showAgentUpdate, setShowAgentUpdate] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: ServerSortKey; dir: SortDir } | null>(null);
  const [page, setPage] = useState(0);
  const counts = useMemo(() => statusCounts(servers), [servers]);
  // filter (status chip + text) → sort → page. Memoised so a keystroke only re-runs the cheap pure steps.
  const rows = useMemo(() => {
    const filtered = filterByText(filterByStatus(servers, status), query);
    return sort
      ? sortServers(filtered, sort.key, sort.dir, { teams, cpu: (id) => latestCpu(trends?.get(id)) })
      : filtered;
  }, [servers, status, query, sort, teams, trends]);
  const pageCount = Math.max(1, Math.ceil(rows.length / SERVER_PAGE_SIZE));
  const curPage = Math.min(page, pageCount - 1);
  const pageRows = useMemo(
    () => rows.slice(curPage * SERVER_PAGE_SIZE, (curPage + 1) * SERVER_PAGE_SIZE),
    [rows, curPage],
  );
  // A new filter always starts from the first page.
  useEffect(() => { setPage(0); }, [status, query]);
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

      <div style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r2)", overflowX: "auto" }}>
        <table style={{ width: "100%", minWidth: 740, borderCollapse: "collapse" }}>
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
              <th scope="col" style={cell} aria-sort={ariaSort("team")}>{sortBtn("team", t("servers.team"))}</th>
              <th scope="col" style={cell} aria-sort={ariaSort("cpu")}>{sortBtn("cpu", t("servers.colTrend"))}</th>
              <th scope="col" style={cell}>{t("servers.access")}</th>
              <th scope="col" style={cell} aria-sort={ariaSort("lastSeen")}>{sortBtn("lastSeen", t("servers.lastSeen"))}</th>
              <th scope="col" style={{ ...cell, width: 70 }}><span className="sr-only">{t("servers.view")}</span></th>
            </tr>
          </thead>
          <tbody>
            {pageRows.map((s) => (
              <tr
                key={s.id}
                className="row-link"
                onClick={(e) => { if (!clickedInteractive(e)) router.push(`/servers/${s.id}`); }}
                style={{ borderTop: "1px solid var(--c-bd)", opacity: s.canWrite ? 1 : 0.6 }}
              >
                <td style={cell}>
                  <input type="checkbox" disabled={!s.canWrite} checked={selected.has(s.id)} onChange={() => toggle(s.id)} aria-label={t("servers.selectRow", { name: s.name })} title={s.canWrite ? "" : t("servers.readonly")} />
                </td>
                <td style={cell}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <StatusDot status={s.status} />
                    <div>
                      <div style={{ fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
                        <Link href={`/servers/${s.id}`} style={{ color: "var(--c-tx)", textDecoration: "none" }}>{s.name}</Link>
                        <TagChips tags={s.tags} />
                      </div>
                      <div className="mono" style={{ fontSize: 11, color: "var(--c-tx3)" }}>{s.hostname ?? "—"}</div>
                    </div>
                  </div>
                </td>
                <td style={cell}>
                  <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 6, background: `${teamColor(s.teamId)}22`, color: teamColor(s.teamId), fontWeight: 600 }}>
                    {teamLabel(teams, s.teamId)}
                  </span>
                </td>
                <td style={cell}>
                  <TrendCell row={trends?.get(s.id)} cpuLabel={t("servers.trendCpu")} memLabel={t("servers.trendMem")} />
                </td>
                <td style={cell}>
                  {!s.canWrite && <Badge tone="muted">{t("servers.readOnly")}</Badge>}
                </td>
                <td style={{ ...cell, color: "var(--c-tx3)" }}>{relativeTime(s.lastSeenAt)}</td>
                <td style={cell}>
                  <Link href={`/servers/${s.id}`} style={{ color: "var(--c-lapis)", fontSize: 12, textDecoration: "none" }}>{t("servers.view")}</Link>
                </td>
              </tr>
            ))}
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

      {rows.length > SERVER_PAGE_SIZE && (
        <nav aria-label={t("servers.pager")} style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 10, marginTop: 12, fontSize: 12, color: "var(--c-tx3)" }}>
          <span role="status" aria-live="polite">
            {t("servers.pageRange", { from: curPage * SERVER_PAGE_SIZE + 1, to: Math.min(rows.length, (curPage + 1) * SERVER_PAGE_SIZE), total: rows.length })}
          </span>
          <Btn variant="ghost" onClick={() => { if (curPage > 0) setPage(curPage - 1); }} aria-disabled={curPage === 0 ? true : undefined} style={curPage === 0 ? pagerDisabledStyle : undefined} aria-label={t("servers.prevPage")}>{t("servers.prev")}</Btn>
          <span aria-current="page">{t("servers.pageOf", { page: curPage + 1, pages: pageCount })}</span>
          <Btn variant="ghost" onClick={() => { if (curPage < pageCount - 1) setPage(curPage + 1); }} aria-disabled={curPage >= pageCount - 1 ? true : undefined} style={curPage >= pageCount - 1 ? pagerDisabledStyle : undefined} aria-label={t("servers.nextPage")}>{t("servers.next")}</Btn>
        </nav>
      )}

      {selected.size > 0 && (
        <div style={{ position: "sticky", bottom: 16, marginTop: 16, display: "flex", alignItems: "center", gap: 12, padding: "10px 16px", background: "var(--c-sb)", border: "1px solid var(--c-a)", borderRadius: "var(--r2)", boxShadow: "0 10px 30px rgba(0,0,0,0.4)" }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>
            {t("servers.selected", { n: writable.length })}
            {skipped > 0 && <span style={{ color: "var(--c-tx3)", fontWeight: 400 }}> {t("servers.skipped", { n: skipped })}</span>}
          </span>
          <div style={{ flex: 1 }} />
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
      {showAgentUpdate && (
        <AgentUpdateBulkModal servers={servers} selectedIds={[...selected]} onClose={() => setShowAgentUpdate(false)} />
      )}
    </div>
  );
}
