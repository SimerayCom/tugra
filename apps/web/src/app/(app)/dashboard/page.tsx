"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowDownRight, ArrowRight, ArrowUpRight, Box, Database, FolderTree, Plus, ScrollText, Server, Settings } from "lucide-react";
import { api } from "../../../lib/api";
import { statusCounts, relativeTime } from "../../../lib/fleet";
import { aggregateFleetTrend, busiestServers, DISK_PRESSURE_PCT, finiteOnly, fleetAttention, fleetSnapshot, trendDelta } from "../../../lib/dashboard";
import { buildFleetRows, metricTone } from "../../../lib/fleet-view";
import { useFleetTrend } from "../../../hooks/useFleetTrend";
import { scopeByTeam } from "../../../lib/team-scope";
import { useTeamScope } from "../../../components/team-scope";
import type { FleetLatestRow, ServerStatus } from "../../../lib/types";
import { useT } from "../../../i18n/provider";
import { Badge, Btn, Card, EmptyState, StatusPill } from "../../../components/ui";
import { ErrorState } from "../../../components/error-state";
import { ListCard, ListRow } from "../../../components/list";
import { ChartCard, MetricChart, Sparkline } from "../../../components/charts";
import { TrendCell } from "../../../components/trend-cell";
import { statusLabel } from "../../../lib/status";
import { Skeleton, SkeletonCard, SkeletonStat, SkeletonTable } from "../../../components/skeleton";

const serverColor = (s: ServerStatus) =>
  s === "ONLINE" ? "var(--c-g)" : s === "PENDING" ? "var(--c-am)" : "var(--c-r)";
const logoBox: React.CSSProperties = {
  width: 40, height: 40, borderRadius: 9, background: "var(--c-tile)",
  display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
};
/** Window of the fleet trend (the shared useFleetTrend hook asks /fleet/metrics/trend for 30 minutes). */
const TREND_MINUTES = 30;
const EMPTY_METRICS: FleetLatestRow[] = []; // stable identity → keeps the memos below from re-running every render
const toneColor = (tone: "ok" | "warn" | "crit") => (tone === "crit" ? "var(--c-r)" : tone === "warn" ? "var(--c-am)" : "var(--c-tx)");
const sectionTitle: React.CSSProperties = {
  fontSize: 11, color: "var(--c-tx3)", margin: "0 0 10px", fontWeight: 700,
  textTransform: "uppercase", letterSpacing: "0.06em",
};

export default function DashboardPage() {
  const t = useT();
  const { teamId } = useTeamScope();
  const { data: allServers = [], isLoading, isError: serversError, refetch: refetchServers } = useQuery({ queryKey: ["servers"], queryFn: () => api.listServers() });
  const { data: allProjects = [] } = useQuery({ queryKey: ["projects"], queryFn: () => api.listProjects() });
  const { data: allApps = [] } = useQuery({ queryKey: ["apps"], queryFn: () => api.listApps() });
  const { data: allDatabases = [] } = useQuery({ queryKey: ["databases"], queryFn: () => api.listDatabases() });
  const { data: allMonitors = [] } = useQuery({ queryKey: ["monitors"], queryFn: () => api.listMonitors() });
  const { data: allDomains = [] } = useQuery({ queryKey: ["domains"], queryFn: () => api.listDomains() });
  // Own key (not ["audit"]) so this plain {entries} result never collides with the Audit page's useInfiniteQuery.
  const { data: audit } = useQuery({ queryKey: ["audit-recent", teamId], queryFn: () => api.listAudit(teamId ?? undefined) });
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
  const recent = audit?.entries.slice(0, 8) ?? [];
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
        <p style={{ color: "var(--c-tx3)", fontSize: 14, margin: "0 0 22px" }}>{t("dashboard.subtitle")}</p>

        <div style={sectionTitle}>{t("dashboard.attention")}</div>
        <div style={{ marginBottom: 28 }}>
          <SkeletonTable rows={2} />
        </div>

        <div style={sectionTitle}>{t("dashboard.fleet")}</div>
        <div style={{ display: "flex", gap: 14, marginBottom: 28, flexWrap: "wrap" }}>
          <SkeletonStat /><SkeletonStat /><SkeletonStat /><SkeletonStat /><SkeletonStat />
        </div>

        <div style={sectionTitle}>{t("dashboard.resources")}</div>
        <div style={{ display: "flex", gap: 14, marginBottom: 24, flexWrap: "wrap" }}>
          <SkeletonStat /><SkeletonStat /><SkeletonStat /><SkeletonStat />
        </div>

        <div style={sectionTitle}>{t("dashboard.projects")}</div>
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

        <div style={sectionTitle}>{t("dashboard.servers")}</div>
        <SkeletonTable rows={4} />

        <div style={{ ...sectionTitle, marginTop: 28 }}>{t("dashboard.recentActivity")}</div>
        <SkeletonTable rows={5} />
      </div>
    );
  }

  const statusTile = (status: ServerStatus, label: string, value: number, color: string, extra?: React.ReactNode) => (
    <Link href={`/servers?status=${status}`} style={{ textDecoration: "none", borderRadius: "var(--r2)", display: "block" }}>
      <Card style={{ padding: 18, height: "100%" }}>
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
        <Card style={{ padding: 18, height: "100%" }}>
          <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 6 }}>{o.label}</div>
          <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 10 }}>
            <div style={{ fontSize: 26, fontWeight: 700, color: o.color }}>{o.value}</div>
            {hasTrend && <Sparkline data={o.series} width={72} height={28} color={o.sparkColor} fixedMax={100} label={o.sparkLabel} />}
          </div>
          <div style={{ fontSize: 11, color: "var(--c-tx3)", marginTop: 6, display: "flex", alignItems: "center", gap: 4 }}>
            {d && (
              <span title={deltaText} style={{ display: "inline-flex", alignItems: "center", gap: 2, color: d.dir === "up" ? "var(--c-am)" : d.dir === "down" ? "var(--c-g)" : "var(--c-tx3)", fontWeight: 600 }}>
                <Arrow size={12} aria-hidden="true" />
                <span aria-hidden="true">{d.dir === "flat" ? "±0" : `${d.dir === "up" ? "+" : "−"}${pts}`}</span>
                <span className="sr-only">{deltaText}</span>
              </span>
            )}
            <span>{win}</span>
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

  return (
    <div style={{ padding: "var(--page-pad)" }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 4px" }}>{t("dashboard.title")}</h1>
      <p style={{ color: "var(--c-tx3)", fontSize: 14, margin: "0 0 22px" }}>{t("dashboard.subtitle")}</p>

      <div style={sectionTitle}>{t("dashboard.attention")}</div>
      {attention.length === 0 ? (
        serversDown ? null : (
        <Card style={{ padding: 14, marginBottom: 28, fontSize: 13, color: "var(--c-tx2)", display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--c-g)" }} /> {t("dashboard.allGood")}
        </Card>
        )
      ) : (
        <ListCard style={{ marginBottom: 28 }}>
          {attention.map((it, i) => {
            const href = it.kind === "server" ? `/servers/${it.id}` : it.kind === "monitor" ? `/monitors/${it.id}` : `/apps/${it.id}`;
            const amber = it.kind === "domain" && it.status === "expiring";
            const color = amber ? "var(--c-am)" : "var(--c-r)";
            const label = it.kind === "server" ? t("dashboard.attentionServer") : it.kind === "monitor" ? t("dashboard.attentionMonitor") : amber ? t("dashboard.attentionSslExpiring") : t("dashboard.attentionSslError");
            return (
              <ListRow key={`${it.kind}-${it.id}`} index={i} href={href} style={{ gap: 10, padding: "11px 16px" }}>
                <AlertTriangle size={15} color={color} style={{ flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{it.name}</div>
                  <div style={{ fontSize: 11, color: "var(--c-tx3)" }}>{label}</div>
                </div>
                <span style={{ fontSize: 12, color, fontWeight: 600 }}>{it.kind === "domain" ? (amber ? t("domains.expiring") : t("domains.noCert")) : statusLabel(t, it.status)}</span>
              </ListRow>
            );
          })}
        </ListCard>
      )}

      {/* Fleet cockpit: clickable status tiles + live health tiles (hide-when-empty) + trend chart + busiest servers */}
      <div style={sectionTitle}>{t("dashboard.fleet")}</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 14, marginBottom: 14 }}>
        {statusTile("ONLINE", t("dashboard.online"), counts.ONLINE, "var(--c-g)")}
        {statusTile("PENDING", t("dashboard.pending"), counts.PENDING, "var(--c-am)")}
        {statusTile("OFFLINE", t("dashboard.offline"), counts.OFFLINE, counts.OFFLINE > 0 ? "var(--c-r)" : "var(--c-tx3)", counts.OFFLINE > 0 && !serversDown ? <AlertTriangle size={13} color="var(--c-r)" aria-hidden="true" /> : null)}
        {snap.cpu !== null && healthTile({
          label: t("dashboard.fleetCpu"), value: `${Math.round(snap.cpu)}%`, color: toneColor(metricTone(snap.cpu)),
          series: cpuSeries, sparkColor: "var(--c-a)", sparkLabel: t("dashboard.fleetCpuTrend", { n: TREND_MINUTES }),
        })}
        {snap.mem !== null && healthTile({
          label: t("dashboard.fleetRam"), value: `${Math.round(snap.mem)}%`, color: toneColor(metricTone(snap.mem)),
          series: memSeries, sparkColor: "var(--c-lapis)", sparkLabel: t("dashboard.fleetRamTrend", { n: TREND_MINUTES }),
        })}
        {snap.diskKnown && (
          <div style={{ borderRadius: "var(--r2)", display: "block" }}>
            <Card style={{ padding: 18, height: "100%" }}>
              <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 6 }}>{t("dashboard.diskPressure")}</div>
              <div style={{ fontSize: 26, fontWeight: 700, color: snap.diskPressure > 0 ? "var(--c-r)" : "var(--c-g)", display: "flex", alignItems: "center", gap: 8 }}>
                {snap.diskPressure > 0 && <AlertTriangle size={18} aria-hidden="true" />}{snap.diskPressure}
              </div>
              <div style={{ fontSize: 11, color: "var(--c-tx3)", marginTop: 6 }}>{t("dashboard.diskPressureSub", { pct: DISK_PRESSURE_PCT })}</div>
            </Card>
          </div>
        )}
      </div>
      {(hasChart || busiest.length > 0) && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 14, marginBottom: 28, alignItems: "start" }}>
          {hasChart && (
            <ChartCard title={t("dashboard.chartTitle")} description={t("dashboard.chartDesc", { n: TREND_MINUTES })}>
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
            </ChartCard>
          )}
          {busiest.length > 0 && (
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--c-tx)" }}>{t("dashboard.busiest")}</div>
              <div style={{ fontSize: 11, lineHeight: 1.4, color: "var(--c-tx3)", margin: "2px 0 10px" }}>{t("dashboard.busiestHint")}</div>
              <ListCard>
                {busiest.map((r, i) => (
                  <ListRow key={r.server.id} index={i} href={`/servers/${r.server.id}`} style={{ padding: "10px 16px" }}>
                    <div style={{ flex: 1, minWidth: 0, fontWeight: 600, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.server.name}</div>
                    <TrendCell row={trends.get(r.server.id)} cpuLabel={t("fleet.trendCpu")} memLabel={t("fleet.trendMem")} width={44} height={20} />
                    <span className="mono" style={{ fontSize: 12, fontWeight: 600, minWidth: 64, textAlign: "right", color: toneColor(metricTone(r.cpu)) }}>{t("dashboard.busiestCpu", { n: Math.round(r.cpu as number) })}</span>
                  </ListRow>
                ))}
              </ListCard>
            </div>
          )}
        </div>
      )}

      <div style={sectionTitle}>{t("dashboard.resources")}</div>
      <div style={{ display: "flex", gap: 14, marginBottom: 24, flexWrap: "wrap" }}>
        {resource("/projects", FolderTree, t("dashboard.projects"), projects.length)}
        {resource("/apps", Box, t("dashboard.apps"), apps.length)}
        {resource("/databases", Database, t("dashboard.databases"), databases.length)}
        {resource("/servers", Server, t("dashboard.totalServers"), isLoading ? "…" : serversDown ? "—" : servers.length)}
      </div>

      {/* Projects (Coolify-style cards with quick actions) */}
      <div style={sectionTitle}>{t("dashboard.projects")}</div>
      {projects.length === 0 ? (
        <Card style={{ marginBottom: 28 }}>
          <EmptyState
            icon={FolderTree}
            title={t("dashboard.noProjectsTitle")}
            action={<Link href="/projects"><Btn>{t("projects.create")}</Btn></Link>}
          >
            {t("dashboard.noProjects")}
          </EmptyState>
        </Card>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 12, marginBottom: 28 }}>
          {projects.map((p) => {
            const appCount = p.environments.reduce((n, e) => n + e.appCount, 0);
            const dbCount = p.environments.reduce((n, e) => n + e.dbCount, 0);
            const env = p.environments[0]?.id ?? "";
            return (
              <Card key={p.id} style={{ padding: 14 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={logoBox}><FolderTree size={20} color="var(--c-a)" /></span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Link href={`/projects/${p.id}`} style={{ fontWeight: 600, fontSize: 14, color: "var(--c-tx)", textDecoration: "none" }}>{p.name}</Link>
                    <div style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
                      <Badge>{p.environments.length} env</Badge>
                      <Badge>{appCount} apps</Badge>
                      <Badge>{dbCount} dbs</Badge>
                    </div>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                  <Link href={`/resources/new?project=${p.id}&env=${env}`} style={chip}><Plus size={13} /> {t("dashboard.addResource")}</Link>
                  <Link href={`/projects/${p.id}`} style={chip}><Settings size={13} /> {t("dashboard.settings")}</Link>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* Servers */}
      <div style={sectionTitle}>{t("dashboard.servers")}</div>
      <ListCard>
        {servers.map((s, i) => (
          <ListRow key={s.id} index={i} href={`/servers/${s.id}`} style={{ padding: "11px 16px" }}>
            <span style={logoBox}><Server size={18} color="var(--c-a)" /></span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{s.name}</div>
              {s.hostname && <div className="mono" style={{ fontSize: 11, color: "var(--c-tx3)" }}>{s.hostname}</div>}
            </div>
            <StatusPill label={statusLabel(t, s.status)} color={serverColor(s.status)} />
          </ListRow>
        ))}
        {serversDown ? (
          <ErrorState onRetry={() => refetchServers()} />
        ) : servers.length === 0 && (
          <EmptyState
            icon={Server}
            title={t("dashboard.noServersTitle")}
            action={<Link href="/servers/new"><Btn>{t("dashboard.addServer")}</Btn></Link>}
          >
            {t("dashboard.noServers")}
          </EmptyState>
        )}
      </ListCard>

      <div style={{ ...sectionTitle, marginTop: 28, display: "flex", alignItems: "center", gap: 8 }}>
        {t("dashboard.recentActivity")}
        <div style={{ flex: 1 }} />
        <Link href="/audit" style={{ fontSize: 11, color: "var(--c-lapis)", textTransform: "none", letterSpacing: 0, fontWeight: 500, textDecoration: "none" }}>{t("dashboard.viewAll")}</Link>
      </div>
      {recent.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--c-tx3)" }}>{t("dashboard.noActivity")}</div>
      ) : (
        <div style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r2)", overflow: "hidden" }}>
          {recent.map((e) => (
            <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 16px", borderTop: "1px solid var(--c-bd)", fontSize: 13 }}>
              <ScrollText size={13} color="var(--c-tx3)" style={{ flexShrink: 0 }} />
              <span style={{ color: "var(--c-tx2)", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.actor}</span>
              <code style={{ fontSize: 12, color: "var(--c-tx3)" }}>{e.action}</code>
              <div style={{ flex: 1 }} />
              <span style={{ color: "var(--c-tx3)", fontSize: 11, whiteSpace: "nowrap" }}>{relativeTime(e.createdAt)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const chip: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, fontWeight: 600,
  color: "var(--c-a)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)",
  padding: "5px 11px", textDecoration: "none",
};
