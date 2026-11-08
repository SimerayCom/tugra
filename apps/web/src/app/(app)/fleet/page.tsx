"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import { useT } from "../../../i18n/provider";
import { useTeamScope } from "../../../components/team-scope";
import { scopeByTeam } from "../../../lib/team-scope";
import { statusCounts, filterByStatus } from "../../../lib/fleet";
import { buildFleetRows, sortFleetRows, matchesFleetSearch, type FleetSortKey, type SortDir } from "../../../lib/fleet-view";
import { useFleetTrend } from "../../../hooks/useFleetTrend";
import { FleetTable } from "../../../components/fleet-table";
import { FleetWall } from "../../../components/fleet-wall";
import {
  FLEET_VIEWS, WALL_METRICS, VIEW_KEY, METRIC_KEY, METRIC_SORT_KEY, readPref, writePref,
  type FleetView, type WallMetric, type WallSort,
} from "../../../lib/fleet-wall";
import { ErrorState } from "../../../components/error-state";
import { SkeletonTable } from "../../../components/skeleton";
import type { FleetLatestRow, ServerStatus } from "../../../lib/types";

const EMPTY_METRICS: FleetLatestRow[] = []; // stable identity → keeps the rows memo from re-running every render

/** Beszel-style fleet overview: every server's live CPU/RAM/disk/net/uptime on one page,
 *  sortable, filterable and searchable, auto-refreshing every 5s. (/servers stays the mgmt list.) */
export default function FleetPage() {
  const t = useT();
  const { teamId } = useTeamScope();
  const { data: servers, isLoading, isError, refetch } = useQuery({
    queryKey: ["servers"],
    queryFn: () => api.listServers(),
    refetchInterval: 5000,
  });
  const { data: metrics = EMPTY_METRICS, isError: metricsError } = useQuery({
    queryKey: ["fleetMetrics"],
    queryFn: () => api.getFleetMetrics(),
    select: (d) => (Array.isArray(d) ? d : EMPTY_METRICS),
    refetchInterval: 5000,
  });
  const trends = useFleetTrend();
  const { data: clusters = [] } = useQuery({ queryKey: ["clusters"], queryFn: () => api.listClusters(), staleTime: 30_000 });

  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [q, setQ] = useState("");
  const [sortKey, setSortKey] = useState<FleetSortKey>("cpu");
  const [sortDir, setSortDir] = useState<SortDir>("desc"); // worst-first by default
  const [view, setViewState] = useState<FleetView>("table"); // Table stays the default; the choice is per-user
  const [metric, setMetricState] = useState<WallMetric>("cpu");
  useEffect(() => {
    // Read after mount (not in the initializer) so server + first client render agree.
    setViewState(readPref(VIEW_KEY, FLEET_VIEWS, "table"));
    setMetricState(readPref(METRIC_KEY, WALL_METRICS, "cpu"));
  }, []);

  // A ticking clock so staleness re-evaluates even when the metrics payload is unchanged between polls
  // (a whole-fleet outage returns identical data, so a data-only dep would never flip the stale flag).
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);

  const clusterName = useMemo(() => {
    const map = new Map(clusters.map((c) => [c.id, c.name]));
    return (id: string) => map.get(id) ?? null;
  }, [clusters]);

  const scoped = useMemo(() => scopeByTeam(servers ?? [], teamId), [servers, teamId]);
  const counts = useMemo(() => statusCounts(scoped), [scoped]);

  // The Table and the Wall keep SEPARATE sort state so switching views never clobbers the other's order.
  // The wall's order is a tiny control: hottest-first by the plotted metric (follows the metric, incl. on
  // restore), or by name / status.
  const [wallSort, setWallSort] = useState<WallSort>("hot");
  const effKey: FleetSortKey = view === "wall" ? (wallSort === "hot" ? METRIC_SORT_KEY[metric] : wallSort) : sortKey;
  const effDir: SortDir = view === "wall" ? (wallSort === "hot" ? "desc" : "asc") : sortDir;

  const rows = useMemo(() => {
    const built = buildFleetRows(filterByStatus(scoped, status), metrics, nowMs).filter((r) => matchesFleetSearch(r, q));
    return sortFleetRows(built, effKey, effDir);
  }, [scoped, status, metrics, nowMs, q, effKey, effDir]);

  const onSort = (k: FleetSortKey) => {
    if (k === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(k);
      setSortDir(k === "name" || k === "status" ? "asc" : "desc");
    }
  };

  const setView = (v: FleetView) => {
    setViewState(v);
    writePref(VIEW_KEY, v);
  };
  const setMetric = (m: WallMetric) => {
    setMetricState(m);
    writePref(METRIC_KEY, m);
  };
  const metricLabel: Record<WallMetric, string> = { cpu: t("fleet.colCpu"), mem: t("fleet.colMem"), disk: t("fleet.colDisk"), net: t("fleet.colNet") };

  return (
    <div style={{ padding: "var(--page-pad)" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>{t("fleet.title")}</h1>
        <span style={{ fontSize: 12.5, color: "var(--c-tx3)" }}>{t("fleet.subtitle")}</span>
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 14 }}>
        <div role="group" aria-label={t("fleet.filterStatus")} style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <Chip active={status === null} onClick={() => setStatus(null)} color="var(--c-tx3)">{t("servers.total", { n: scoped.length })}</Chip>
          <Chip active={status === "ONLINE"} onClick={() => setStatus("ONLINE")} color="var(--c-g)">● {t("servers.online", { n: counts.ONLINE })}</Chip>
          <Chip active={status === "PENDING"} onClick={() => setStatus("PENDING")} color="var(--c-am)">● {t("servers.pending", { n: counts.PENDING })}</Chip>
          <Chip active={status === "OFFLINE"} onClick={() => setStatus("OFFLINE")} color="var(--c-r)">● {t("servers.offline", { n: counts.OFFLINE })}</Chip>
        </div>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("fleet.search")}
          aria-label={t("fleet.search")}
          className="fleet-chip"
          style={{ marginLeft: "auto", minWidth: 180, flex: "0 1 260px", padding: "7px 11px", background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", color: "var(--c-tx)", fontSize: 13, fontFamily: "inherit" }}
        />
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 14 }}>
        <Segmented
          label={t("fleet.view")}
          value={view}
          onChange={setView}
          options={[{ value: "table", label: t("fleet.viewTable") }, { value: "wall", label: t("fleet.viewWall") }]}
        />
        {view === "wall" && (
          <>
            <Segmented
              label={t("fleet.wallMetric")}
              value={metric}
              onChange={setMetric}
              options={WALL_METRICS.map((m) => ({ value: m, label: metricLabel[m] }))}
            />
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--c-tx3)", marginLeft: "auto" }}>
              {t("fleet.wallSort")}
              <select
                value={wallSort}
                onChange={(e) => setWallSort(e.target.value as WallSort)}
                className="fleet-chip"
                style={{ padding: "6px 8px", background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", color: "var(--c-tx)", fontSize: 12.5, fontFamily: "inherit" }}
              >
                <option value="hot">{t("fleet.sortHot")}</option>
                <option value="name">{t("fleet.sortName")}</option>
                <option value="status">{t("fleet.sortStatus")}</option>
              </select>
            </label>
          </>
        )}
      </div>

      {metricsError && servers && (
        <div role="status" style={{ marginBottom: 10, fontSize: 12.5, color: "var(--c-am)" }}>{t("fleet.metricsError")}</div>
      )}

      {isLoading && !servers && <SkeletonTable rows={6} />}
      {isError && !servers && <ErrorState onRetry={() => refetch()} />}
      {servers && view === "wall" && <FleetWall rows={rows} metric={metric} trends={trends} />}
      {servers && view === "table" && <FleetTable rows={rows} sortKey={sortKey} sortDir={sortDir} onSort={onSort} clusterName={clusterName} trends={trends} />}
    </div>
  );
}

function Chip({ active, onClick, color, children }: { active: boolean; onClick: () => void; color: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      className="fleet-chip"
      onClick={onClick}
      aria-pressed={active}
      style={{
        all: "unset", cursor: "pointer", padding: "7px 12px", borderRadius: 999, fontSize: 12, fontWeight: 500,
        color: active ? "var(--c-tx)" : "var(--c-tx3)", background: active ? "var(--c-el)" : "transparent",
        border: `1px solid ${active ? "var(--c-a)" : "var(--c-bd)"}`, display: "inline-flex", alignItems: "center", gap: 5,
      }}
    >
      <span style={{ color }}>{children}</span>
    </button>
  );
}

/** Segmented control: a labelled group of toggle buttons (aria-pressed), one active. */
function Segmented<T extends string>({ label, value, onChange, options }: { label: string; value: T; onChange: (v: T) => void; options: { value: T; label: string }[] }) {
  return (
    <div role="group" aria-label={label} style={{ display: "inline-flex", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", overflow: "hidden" }}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            className="fleet-chip"
            aria-pressed={active}
            onClick={() => onChange(o.value)}
            style={{
              all: "unset", cursor: "pointer", padding: "6px 12px", fontSize: 12, fontWeight: active ? 600 : 500,
              color: active ? "var(--c-tx)" : "var(--c-tx3)", background: active ? "var(--c-el)" : "transparent",
              boxShadow: active ? "inset 0 -2px 0 var(--c-a)" : "none",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
