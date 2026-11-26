"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowDownRight, ArrowRight, ArrowUpRight, Box, Database, FolderTree, SlidersHorizontal, Server } from "lucide-react";
import { api } from "../../../lib/api";
import { statusCounts } from "../../../lib/fleet";
import { aggregateFleetTrend, busiestServers, DISK_PRESSURE_PCT, finiteOnly, fleetAttention, fleetSnapshot, trendDelta } from "../../../lib/dashboard";
import { buildFleetRows, metricTone } from "../../../lib/fleet-view";
import { useFleetTrend } from "../../../hooks/useFleetTrend";
import { useHubHealth } from "../../../hooks/useHubHealth";
import { HubHealthAttention } from "../../../components/dashboard/hub-health-attention";
import { scopeByTeam, scopeTeamName } from "../../../lib/team-scope";
import { LIST_LIMIT, limitRows } from "../../../lib/dashboard-lists";
import { useDashboardLayout, visibleCards, type DashboardCardId } from "../../../lib/dashboard-layout";
import { useAuth } from "../../../lib/auth";
import { useTeamScope } from "../../../components/team-scope";
import type { FleetLatestRow, ServerStatus } from "../../../lib/types";
import { useT } from "../../../i18n/provider";
import { Btn, Card, LinkBtn } from "../../../components/ui";
import { ListCard, ListRow } from "../../../components/list";
import { ChartCard, MetricChart, Sparkline } from "../../../components/charts";
import { TrendCell } from "../../../components/trend-cell";
import { HottestContainersCard } from "../../../components/hottest-containers-card";
import { statusLabel } from "../../../lib/status";
import { Skeleton, SkeletonCard, SkeletonStat, SkeletonTable } from "../../../components/skeleton";
import { DashCard, SeeAll, sectionTitle } from "../../../components/dashboard/dash-card";
import { ActivityCard } from "../../../components/dashboard/activity-card";
import { CustomizePanel } from "../../../components/dashboard/customize-panel";
import { ProjectsCard } from "../../../components/dashboard/projects-card";
import { ServersCard } from "../../../components/dashboard/servers-card";
import { BackupsCard, CertsCard, DeploysCard, DiskForecastCard, MigrationsCard, UpdatesCard, UptimeCard } from "../../../components/dashboard/insight-cards";
/** Window of the fleet trend (the shared useFleetTrend hook asks /fleet/metrics/trend for 30 minutes). */
const TREND_MINUTES = 30;
const EMPTY_METRICS: FleetLatestRow[] = []; // stable identity → keeps the memos below from re-running every render
const toneColor = (tone: "ok" | "warn" | "crit") => (tone === "crit" ? "var(--c-r)" : tone === "warn" ? "var(--c-am)" : "var(--c-tx)");
const loadingTitle: React.CSSProperties = { ...sectionTitle, margin: "0 0 10px" };

/**
 * Fleet tile grid, shared by the loading skeleton and the loaded cockpit. `auto-fill` (NOT `auto-fit`) keeps the
 * column tracks identical whether 3 status tiles or 6 tiles are present, so the CPU/RAM tiles landing after the
 * metrics fetch fill an existing cell instead of reflowing (re-widening) every tile in the row.
 */
const FLEET_GRID: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))", gap: 14 };
/** Reserved box of the tile's sparkline slot (also its drawn size) — present with or without trend data. */
const SPARK_W = 72;
const SPARK_H = 28;
/**
 * Shared min-height of EVERY fleet-row tile (status, CPU/RAM, disk) and of the loading skeleton tiles. It is the
 * natural height of the tallest (health) tile — 18+18 padding, 15 label + 6, 28 value/sparkline, 6 + 16 delta line,
 * 2 border — rounded up, so the row is identical from first paint to loaded and nothing below shifts vertically.
 */
const FLEET_TILE_MIN_H = 112;

/** Keeps a chart/list slot at its final height when it has no data yet, so nothing below it shifts. */
function SlotPlaceholder({ height, text }: { height: number; text: string }) {
  return (
    <div role="status" style={{ minHeight: height, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "var(--c-tx3)", textAlign: "center" }}>
      {text}
    </div>
  );
}

export default function DashboardPage() {
  const t = useT();
  const { teamId } = useTeamScope();
  const { data: allServers = [], isLoading, isError: serversError, refetch: refetchServers } = useQuery({ queryKey: ["servers"], queryFn: () => api.listServers() });
  const { data: allProjects = [] } = useQuery({ queryKey: ["projects"], queryFn: () => api.listProjects() });
  const { data: allApps = [], isSuccess: appsLoaded } = useQuery({ queryKey: ["apps"], queryFn: () => api.listApps() });
  const { data: allDatabases = [], isSuccess: dbsLoaded } = useQuery({ queryKey: ["databases"], queryFn: () => api.listDatabases() });
  const { data: teams = [] } = useQuery({ queryKey: ["teams"], queryFn: () => api.listTeams() });
  // "All your teams" is only true with no team picked in the switcher.
  const scopeName = scopeTeamName(teams, teamId);
  const subtitle = scopeName ? t("dashboard.subtitleTeam", { team: scopeName }) : t("dashboard.subtitle");
  const monitorsQ = useQuery({ queryKey: ["monitors"], queryFn: () => api.listMonitors() });
  const allMonitors = monitorsQ.data ?? [];
  const domainsQ = useQuery({ queryKey: ["domains"], queryFn: () => api.listDomains() });
  const allDomains = domainsQ.data ?? [];
  const { user } = useAuth();
  // Owner only: a compact line in Needs attention when the hub itself is unhealthy (heap near its cap, loop lag, restarts...).
  const hubHealth = useHubHealth(!!user?.isInstanceOwner).data;
  const hubWarnings = hubHealth && !hubHealth.healthy ? hubHealth.warnings : [];
  const [layout, setLayout, resetLayout] = useDashboardLayout(user?.id);
  const [customizing, setCustomizing] = useState(false);
  const [allAttention, setAllAttention] = useState(false);
  // Fleet cockpit data: newest sample per server + the batched 30-min trend (both fleet-wide single calls; no
  // per-server history fan-out). A failure just hides the live tiles — decoration, never a reason to break the page.
  const { data: latest = EMPTY_METRICS } = useQuery({
    queryKey: ["fleetMetrics"],
    queryFn: () => api.getFleetMetrics(),
    select: (d) => (Array.isArray(d) ? d : EMPTY_METRICS),
    refetchInterval: 10_000,
  });
  const trends = useFleetTrend();
  // Ticking clock so staleness re-evaluates even when an unchanged payload keeps the same identity.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 10_000);
    return () => clearInterval(id);
  }, []);
  const servers = scopeByTeam(allServers, teamId);
  const projects = scopeByTeam(allProjects, teamId);
  const apps = scopeByTeam(allApps, teamId);
  const databases = scopeByTeam(allDatabases, teamId);
  const monitors = scopeByTeam(allMonitors, teamId);
  const domains = scopeByTeam(allDomains, teamId);
  const counts = statusCounts(servers);
  const attention = fleetAttention(servers, monitors, domains);
  // Servers is the dashboard's spine (fleet stats, attention, server list all derive
  // from it). When its fetch fails with nothing cached we can't claim "all normal" or
  // invite "Add server" — surface the error in the Servers section and neutralize the
  // counts instead of contradicting ourselves with a green banner next to a red error.
  const serversDown = serversError && allServers.length === 0;

  // Cheap pure derivations (a handful of servers x <=30 minutes) — recomputed per render, no memo needed.
  const rows = buildFleetRows(servers, latest, nowMs);
  const snap = fleetSnapshot(rows);
  const busiest = busiestServers(rows);
  const agg = aggregateFleetTrend([...trends.values()], new Set(servers.map((s) => s.id)));
  const cpuSeries = finiteOnly(agg.cpu);
  const memSeries = finiteOnly(agg.mem);
  const hasChart = cpuSeries.length >= 2 || memSeries.length >= 2;

  if (isLoading) {
    return (
      <div style={{ padding: "var(--page-pad)" }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 4px" }}>{t("dashboard.title")}</h1>
        <p style={{ color: "var(--c-tx3)", fontSize: 14, margin: "0 0 22px" }}>{subtitle}</p>

        <div style={loadingTitle}>{t("dashboard.attention")}</div>
        <div style={{ marginBottom: 28 }}>
          <SkeletonTable rows={2} />
        </div>

        <div style={loadingTitle}>{t("dashboard.fleet")}</div>
        <div style={{ ...FLEET_GRID, marginBottom: 28 }}>
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} data-testid="fleet-skeleton-tile" style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r2)", padding: 18, minHeight: FLEET_TILE_MIN_H, boxSizing: "border-box" }}>
              <Skeleton height={12} width="55%" style={{ marginBottom: 10 }} />
              <Skeleton height={26} width="40%" />
            </div>
          ))}
        </div>

        <div style={loadingTitle}>{t("dashboard.resources")}</div>
        <div style={{ display: "flex", gap: 14, marginBottom: 24, flexWrap: "wrap" }}>
          <SkeletonStat /><SkeletonStat /><SkeletonStat /><SkeletonStat />
        </div>

        <div style={loadingTitle}>{t("dashboard.projects")}</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 12, marginBottom: 28 }}>
          {Array.from({ length: 3 }).map((_, i) => (
            <SkeletonCard key={i} style={{ padding: 14 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <Skeleton width={40} height={40} radius={9} style={{ flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Skeleton height={14} width="55%" style={{ marginBottom: 8 }} />
                  <Skeleton height={18} width="80%" />
                </div>
              </div>
            </SkeletonCard>
          ))}
        </div>

        <div style={loadingTitle}>{t("dashboard.servers")}</div>
        <SkeletonTable rows={4} />

        <div style={{ ...loadingTitle, marginTop: 28 }}>{t("dashboard.recentActivity")}</div>
        <SkeletonTable rows={5} />
      </div>
    );
  }

  const statusTile = (status: ServerStatus, label: string, value: number, color: string, extra?: React.ReactNode) => (
    <Link href={`/servers?status=${status}`} style={{ textDecoration: "none", borderRadius: "var(--r2)", display: "block" }}>
      <Card style={{ padding: 18, height: "100%", minHeight: FLEET_TILE_MIN_H, boxSizing: "border-box" }}>
        <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 6, display: "flex", alignItems: "center", gap: 6 }}>{label}{extra}</div>
        <div style={{ fontSize: 26, fontWeight: 700, color }}>
          {serversDown ? "—" : value}
          {status === "ONLINE" && !serversDown && (
            <span style={{ fontSize: 12, fontWeight: 500, color: "var(--c-tx3)", marginLeft: 6 }}>{t("dashboard.onlineOf", { n: servers.length })}</span>
          )}
        </div>
      </Card>
    </Link>
  );

  // One live-metric tile: current value, an aggregate sparkline and an honest window label + delta.
  const healthTile = (o: { label: string; value: string; color: string; series: number[]; sparkColor: string; sparkLabel: string }) => {
    const d = trendDelta(o.series);
    // The big number is the CURRENT mean over live servers; only claim a 30-min window when the trend is drawn.
    const hasTrend = o.series.length >= 2;
    const win = hasTrend ? t("dashboard.window", { n: TREND_MINUTES }) : t("dashboard.fleetAvgHint");
    const Arrow = d?.dir === "up" ? ArrowUpRight : d?.dir === "down" ? ArrowDownRight : ArrowRight;
    const pts = d ? Math.round(Math.abs(d.delta)) : 0;
    const deltaText = !d ? "" : d.dir === "up" ? t("dashboard.deltaUp", { pts, n: TREND_MINUTES }) : d.dir === "down" ? t("dashboard.deltaDown", { pts, n: TREND_MINUTES }) : t("dashboard.deltaFlat", { n: TREND_MINUTES });
    return (
      <Link href="/fleet" style={{ textDecoration: "none", borderRadius: "var(--r2)", display: "block" }}>
        <Card style={{ padding: 18, height: "100%", minHeight: FLEET_TILE_MIN_H, boxSizing: "border-box" }}>
          <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 6 }}>{o.label}</div>
          <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 10, minHeight: SPARK_H }}>
            <div style={{ fontSize: 26, fontWeight: 700, color: o.color }}>{o.value}</div>
            {/* Fixed-size slot, always mounted: the tile keeps the same box before/after the trend arrives. */}
            <span data-testid="spark-slot" style={{ width: SPARK_W, height: SPARK_H, flexShrink: 0, display: "block" }}>
              {hasTrend && <Sparkline data={o.series} width={SPARK_W} height={SPARK_H} color={o.sparkColor} fixedMax={100} label={o.sparkLabel} />}
            </span>
          </div>
          <div style={{ fontSize: 11, color: "var(--c-tx3)", marginTop: 6, display: "flex", alignItems: "center", gap: 4, minHeight: 16, whiteSpace: "nowrap" }}>
            {d && (
              <span title={deltaText} style={{ display: "inline-flex", alignItems: "center", gap: 2, color: d.dir === "up" ? "var(--c-am)" : d.dir === "down" ? "var(--c-g)" : "var(--c-tx3)", fontWeight: 600 }}>
                <Arrow size={12} aria-hidden="true" />
                <span aria-hidden="true">{d.dir === "flat" ? "±0" : `${d.dir === "up" ? "+" : "−"}${pts}`}</span>
                <span className="sr-only">{deltaText}</span>
              </span>
            )}
            <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }} title={win}>{win}</span>
          </div>
        </Card>
      </Link>
    );
  };

  const resource = (href: string, Icon: typeof Server, label: string, value: number | string) => (
    <Link href={href} style={{ textDecoration: "none", flex: 1, minWidth: 150 }}>
      <Card style={{ padding: 18, display: "flex", alignItems: "center", gap: 14 }}>
        <Icon size={26} color="var(--c-a)" />
        <div>
          <div style={{ fontSize: 24, fontWeight: 700, color: "var(--c-tx)" }}>{value}</div>
          <div style={{ fontSize: 12, color: "var(--c-tx3)" }}>{label}</div>
        </div>
      </Card>
    </Link>
  );

  const noResources = appsLoaded && dbsLoaded && apps.length === 0 && databases.length === 0;
  const attentionShown = allAttention ? attention : attention.slice(0, LIST_LIMIT);

  const cards: Record<DashboardCardId, ReactNode> = {
    attention: (
      <DashCard
        id="attention"
        title={t("dashboard.attention")}
        right={attention.length > LIST_LIMIT ? (
          <button type="button" onClick={() => setAllAttention((v) => !v)} aria-expanded={allAttention} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontSize: 11, color: "var(--c-lapis)", fontWeight: 500 }}>
            {allAttention ? t("dashboard.showFewer") : t("dashboard.seeAll", { n: attention.length })}
          </button>
        ) : null}
      >
        <HubHealthAttention warnings={hubWarnings} spaced={attention.length > 0} />
        {attention.length === 0 ? (
          serversDown || hubWarnings.length > 0 ? null : (
            <Card style={{ padding: 14, fontSize: 13, color: "var(--c-tx2)", display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--c-g)" }} /> {t("dashboard.allGood")}
            </Card>
          )
        ) : (
          <ListCard>
            {attentionShown.map((it, i) => {
              const href = it.kind === "server" || it.kind === "exposed" ? `/servers/${it.id}` : it.kind === "monitor" ? `/monitors/${it.id}` : `/apps/${it.id}`;
              const amber = it.kind === "domain" && it.status === "expiring";
              const color = amber ? "var(--c-am)" : "var(--c-r)";
              const label = it.kind === "exposed" ? t("dashboard.attentionExposed") : it.kind === "server" ? t("dashboard.attentionServer") : it.kind === "monitor" ? t("dashboard.attentionMonitor") : amber ? t("dashboard.attentionSslExpiring") : t("dashboard.attentionSslError");
              return (
                <ListRow key={`${it.kind}-${it.id}`} index={i} href={href} style={{ gap: 10, padding: "11px 16px" }}>
                  <AlertTriangle size={15} color={color} style={{ flexShrink: 0 }} aria-hidden />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{it.name}</div>
                    <div style={{ fontSize: 11, color: "var(--c-tx3)" }}>{label}</div>
                  </div>
                  <span style={{ fontSize: 12, color, fontWeight: 600 }}>{it.kind === "exposed" ? t("dashboard.attentionExposedCount", { n: it.count ?? 0 }) : it.kind === "domain" ? (amber ? t("domains.expiring") : t("domains.noCert")) : statusLabel(t, it.status)}</span>
                </ListRow>
              );
            })}
          </ListCard>
        )}
      </DashCard>
    ),

    // Fleet cockpit: clickable status tiles + live health tiles (placeholder-until-loaded) + trend chart + busiest servers
    fleet: (
      <DashCard id="fleet" title={t("dashboard.fleet")} style={{ marginBottom: 14 }}>
        <div data-testid="fleet-grid" style={{ ...FLEET_GRID, marginBottom: 14 }}>
          {statusTile("ONLINE", t("dashboard.online"), counts.ONLINE, "var(--c-g)")}
          {statusTile("PENDING", t("dashboard.pending"), counts.PENDING, "var(--c-am)")}
          {statusTile("OFFLINE", t("dashboard.offline"), counts.OFFLINE, counts.OFFLINE > 0 ? "var(--c-r)" : "var(--c-tx3)", counts.OFFLINE > 0 && !serversDown ? <AlertTriangle size={13} color="var(--c-r)" aria-hidden="true" /> : null)}
          {/* Always rendered (placeholder value until the metrics land) so the row keeps one height from first paint. */}
          {healthTile({
            label: t("dashboard.fleetCpu"), value: snap.cpu !== null ? `${Math.round(snap.cpu)}%` : "—", color: snap.cpu !== null ? toneColor(metricTone(snap.cpu)) : "var(--c-tx3)",
            series: cpuSeries, sparkColor: "var(--c-a)", sparkLabel: t("dashboard.fleetCpuTrend", { n: TREND_MINUTES }),
          })}
          {healthTile({
            label: t("dashboard.fleetRam"), value: snap.mem !== null ? `${Math.round(snap.mem)}%` : "—", color: snap.mem !== null ? toneColor(metricTone(snap.mem)) : "var(--c-tx3)",
            series: memSeries, sparkColor: "var(--c-lapis)", sparkLabel: t("dashboard.fleetRamTrend", { n: TREND_MINUTES }),
          })}
          <div style={{ borderRadius: "var(--r2)", display: "block" }}>
            <Card style={{ padding: 18, height: "100%", minHeight: FLEET_TILE_MIN_H, boxSizing: "border-box" }}>
              <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 6 }}>{t("dashboard.diskPressure")}</div>
              <div style={{ fontSize: 26, fontWeight: 700, color: !snap.diskKnown ? "var(--c-tx3)" : snap.diskPressure > 0 ? "var(--c-r)" : "var(--c-g)", display: "flex", alignItems: "center", gap: 8 }}>
                {snap.diskKnown && snap.diskPressure > 0 && <AlertTriangle size={18} aria-hidden />}{snap.diskKnown ? snap.diskPressure : "—"}
              </div>
              <div style={{ fontSize: 11, color: "var(--c-tx3)", marginTop: 6 }}>{t("dashboard.diskPressureSub", { pct: DISK_PRESSURE_PCT })}</div>
            </Card>
          </div>
        </div>
        {(hasChart || busiest.length > 0) && (
          // Fixed two-slot grid: BOTH slots are always rendered once the block shows, so the chart keeps one width from
          // first paint — a late-loading "Busiest" list fills its reserved slot instead of splitting a full-width chart.
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 420px), 1fr))", gap: 14, alignItems: "start" }}>
            <ChartCard title={t("dashboard.chartTitle")} description={t("dashboard.chartDesc", { n: TREND_MINUTES })}>
              {hasChart ? (
                <MetricChart
                  bare
                  label={t("dashboard.chartTitle")}
                  unit="%"
                  height={140}
                  times={agg.times}
                  series={[
                    { key: "cpu", label: t("servers.cpu"), values: agg.cpu, kind: "line" },
                    { key: "mem", label: t("servers.ram"), values: agg.mem, kind: "line" },
                  ]}
                />
              ) : (
                <SlotPlaceholder height={140} text={t("dashboard.waitingForData")} />
              )}
            </ChartCard>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--c-tx)" }}>{t("dashboard.busiest")}</div>
              <div style={{ fontSize: 11, lineHeight: 1.4, color: "var(--c-tx3)", margin: "2px 0 10px" }}>{t("dashboard.busiestHint")}</div>
              {busiest.length > 0 ? (
                <ListCard>
                  {busiest.map((r, i) => (
                    <ListRow key={r.server.id} index={i} href={`/servers/${r.server.id}`} style={{ padding: "10px 16px" }}>
                      <div style={{ flex: 1, minWidth: 0, fontWeight: 600, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.server.name}</div>
                      <TrendCell row={trends.get(r.server.id)} cpuLabel={t("fleet.trendCpu")} memLabel={t("fleet.trendMem")} width={44} height={20} />
                      <span className="mono" style={{ fontSize: 12, fontWeight: 600, minWidth: 64, textAlign: "right", color: toneColor(metricTone(r.cpu)) }}>{t("dashboard.busiestCpu", { n: Math.round(r.cpu as number) })}</span>
                    </ListRow>
                  ))}
                </ListCard>
              ) : (
                <Card style={{ padding: 16 }}>
                  <SlotPlaceholder height={140} text={t("dashboard.busiestEmpty")} />
                </Card>
              )}
            </div>
          </div>
        )}
      </DashCard>
    ),

    hottest: !serversDown && servers.length > 0 ? <HottestContainersCard teamId={teamId} /> : null,
    diskForecast: <DiskForecastCard teamId={teamId} />,
    certs: <CertsCard domains={domains} feed={{ isLoading: domainsQ.isLoading, isError: domainsQ.isError && !domainsQ.data, refetch: domainsQ.refetch }} />,
    backups: <BackupsCard teamId={teamId} />,
    updates: <UpdatesCard servers={servers} />,
    uptime: <UptimeCard servers={servers} monitors={monitors} feed={{ isLoading: monitorsQ.isLoading, isError: monitorsQ.isError && !monitorsQ.data, refetch: monitorsQ.refetch }} />,
    deploys: <DeploysCard teamId={teamId} />,
    migrations: <MigrationsCard teamId={teamId} />,

    resources: (
      <DashCard id="resources" title={t("dashboard.resources")} style={{ marginBottom: 24 }}>
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
          {resource("/projects", FolderTree, t("dashboard.projects"), projects.length)}
          {resource("/apps", Box, t("dashboard.apps"), apps.length)}
          {resource("/databases", Database, t("dashboard.databases"), databases.length)}
          {resource("/servers", Server, t("dashboard.totalServers"), isLoading ? "…" : serversDown ? "—" : servers.length)}
        </div>
        {noResources && (
          <Card style={{ marginTop: 14, padding: 16, display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 220px", minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>{t("dashboard.ctaTitle")}</div>
              <div style={{ fontSize: 12, color: "var(--c-tx3)", marginTop: 2 }}>{t("dashboard.ctaBody")}</div>
            </div>
            <LinkBtn href="/import" variant="ghost">{t("dashboard.ctaImport")}</LinkBtn>
            <LinkBtn href="/resources/new">{t("dashboard.ctaDeploy")}</LinkBtn>
          </Card>
        )}
      </DashCard>
    ),

    projects: <ProjectsCard projects={projects} teams={teams} apps={apps} databases={databases} teamId={teamId} />,
    servers: <ServersCard rows={rows} down={serversDown} onRetry={() => refetchServers()} />,
    activity: <ActivityCard teamId={teamId} />,
  };
  const shown = visibleCards(layout);

  return (
    <div style={{ padding: "var(--page-pad)" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, flexWrap: "wrap", margin: "0 0 22px" }}>
        <div style={{ flex: "1 1 240px", minWidth: 0 }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 4px" }}>{t("dashboard.title")}</h1>
          <p style={{ color: "var(--c-tx3)", fontSize: 14, margin: 0 }}>{subtitle}</p>
        </div>
        <Btn variant="ghost" icon={SlidersHorizontal} aria-expanded={customizing} onClick={() => setCustomizing((v) => !v)}>{t("dashboard.customize")}</Btn>
      </div>

      {customizing && <CustomizePanel layout={layout} onChange={setLayout} onReset={resetLayout} onClose={() => setCustomizing(false)} />}
      {shown.length === 0 && <Card style={{ padding: 16, fontSize: 13, color: "var(--c-tx3)" }}>{t("dashboard.allCardsHidden")}</Card>}
      {shown.map((id) => <div key={id}>{cards[id]}</div>)}
    </div>
  );
}
