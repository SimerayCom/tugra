"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import { useT } from "../../../i18n/provider";
import { useTeamScope } from "../../../components/team-scope";
import { scopeByTeam } from "../../../lib/team-scope";
import { statusCounts, filterByStatus } from "../../../lib/fleet";
import { buildFleetRows, sortFleetRows, matchesFleetSearch, type FleetSortKey, type SortDir } from "../../../lib/fleet-view";
import { FleetTable } from "../../../components/fleet-table";
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
  const { data: clusters = [] } = useQuery({ queryKey: ["clusters"], queryFn: () => api.listClusters(), staleTime: 30_000 });

  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [q, setQ] = useState("");
  const [sortKey, setSortKey] = useState<FleetSortKey>("cpu");
  const [sortDir, setSortDir] = useState<SortDir>("desc"); // worst-first by default

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

  const rows = useMemo(() => {
    const built = buildFleetRows(filterByStatus(scoped, status), metrics, nowMs).filter((r) => matchesFleetSearch(r, q));
    return sortFleetRows(built, sortKey, sortDir);
  }, [scoped, status, metrics, nowMs, q, sortKey, sortDir]);

  const onSort = (k: FleetSortKey) => {
    if (k === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(k);
      setSortDir(k === "name" || k === "status" ? "asc" : "desc");
    }
  };

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

      {metricsError && servers && (
        <div role="status" style={{ marginBottom: 10, fontSize: 12.5, color: "var(--c-am)" }}>{t("fleet.metricsError")}</div>
      )}

      {isLoading && !servers && <SkeletonTable rows={6} />}
      {isError && !servers && <ErrorState onRetry={() => refetch()} />}
      {servers && <FleetTable rows={rows} sortKey={sortKey} sortDir={sortDir} onSort={onSort} clusterName={clusterName} />}
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
