"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../../lib/api";
import type { Application, MetricsRange, TrafficBreakdownDim } from "../../../../lib/types";
import { useI18n } from "../../../../i18n/provider";
import { Btn, Card, Spinner } from "../../../../components/ui";
import { ErrorState } from "../../../../components/error-state";
import { Select } from "../../../../components/form";
import { useTrafficAnalyticsToggle } from "../../../../components/traffic-analytics-card";
import { BreakdownCard, CountriesList, PathsTable, StatTiles, TrafficCharts } from "../../../../components/traffic/traffic-panels";
import { useTrafficData } from "../../../../hooks/useTrafficData";

const RANGES: MetricsRange[] = ["1h", "6h", "24h", "7d", "30d"];
const ALL = "__all__"; // <Select> reserves "" for its disabled placeholder, so "all domains" gets a sentinel

/**
 * Per-app visitor analytics: the same panels as the global Traffic page, scoped (by the hub) to this app's own hosts:
 * primary domain, aliases and per-service domains. Read-level, so every viewer sees it. Shows traffic recorded on the
 * app's own server only; a clustered app carries a note saying so.
 */
export function AnalyticsTab({ app }: { app: Application }) {
  const { t, lang } = useI18n();
  const [range, setRange] = useState<MetricsRange>("24h");
  const [hostSel, setHostSel] = useState(ALL);
  const [dim, setDim] = useState<TrafficBreakdownDim>("browser");

  // Hosts come from the app's links (primary, aliases, service domains); a raw IP:port link has none.
  const hosts = [...new Set(app.links.map((l) => l.host).filter((h): h is string => !!h))];
  const domain = hostSel !== ALL && hosts.includes(hostSel) ? hostSel : undefined;

  const server = useQuery({ queryKey: ["server", app.serverId], queryFn: () => api.getServer(app.serverId) });
  // Only a loaded server that says it is off blocks the panels; an unreadable server never hides real data.
  const serverOff = server.data?.trafficAnalytics === false;
  const noHost = hosts.length === 0;
  const showData = !noHost && !serverOff && !server.isLoading;
  const data = useTrafficData({ range, teamId: app.teamId, domain, appId: app.id, enabled: showData });
  const enable = useTrafficAnalyticsToggle(app.serverId);

  const clusterNote = app.clusterId ? (
    <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "12px 0 0", lineHeight: 1.5 }}>{t("apps.analyticsClusterNote")}</p>
  ) : null;

  const hostOptions = [{ value: ALL, label: t("apps.analyticsAllDomains") }, ...hosts.map((h) => ({ value: h, label: h }))];

  let body;
  if (noHost) {
    body = <Card style={{ padding: 16 }}><p style={{ fontSize: 13, color: "var(--c-tx2)", margin: 0, lineHeight: 1.5 }}>{t("apps.analyticsNoDomain")}</p></Card>;
  } else if (server.isLoading) {
    body = <Card style={{ padding: 16, display: "flex", justifyContent: "center" }}><Spinner /></Card>;
  } else if (serverOff) {
    body = (
      <Card style={{ padding: 16 }}>
        {server.data?.canWrite ? (
          <div data-testid="analytics-enable-row" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <p style={{ flex: "1 1 260px", fontSize: 13, color: "var(--c-tx2)", margin: 0, lineHeight: 1.5 }}>{t("apps.analyticsServerOff", { name: server.data.name })}</p>
            <Btn loading={enable.isPending} disabled={enable.isPending} aria-label={t("traffic.enableFor", { name: server.data.name })} onClick={() => enable.mutate(true)}>
              {t("traffic.enableBtn")}
            </Btn>
          </div>
        ) : (
          <p style={{ fontSize: 13, color: "var(--c-tx2)", margin: 0, lineHeight: 1.5 }}>{t("apps.analyticsServerOffReadOnly")}</p>
        )}
        {clusterNote}
      </Card>
    );
  } else if (data.failed) {
    body = <Card style={{ padding: 16 }}><ErrorState onRetry={data.refetch} /></Card>;
  } else if (data.loading) {
    body = <Card style={{ padding: 16, display: "flex", justifyContent: "center" }}><Spinner /></Card>;
  } else if (data.empty) {
    body = (
      <Card style={{ padding: 16 }}>
        <p style={{ fontSize: 13, color: "var(--c-tx2)", margin: 0, lineHeight: 1.5 }}>{t("apps.analyticsNoData")}</p>
        {clusterNote}
      </Card>
    );
  } else {
    body = (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {data.summary.data && <StatTiles summary={data.summary.data} />}
        {data.summary.data && <TrafficCharts summary={data.summary.data} />}
        <BreakdownCard dim={dim} onDim={setDim} range={range} teamId={app.teamId} domain={domain} appId={app.id} />
        <CountriesList rows={data.countries.data?.countries ?? []} totalRequests={data.summary.data?.totals.requests} lang={lang} />
        <PathsTable data={data.paths.data} />
        {clusterNote}
      </div>
    );
  }

  return (
    <div>
      {!noHost && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
          <div role="group" aria-label={t("traffic.range")} style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {RANGES.map((r) => (
              <Btn key={r} variant={r === range ? "primary" : "ghost"} aria-pressed={r === range} onClick={() => setRange(r)}>
                {t(`apps.metricsRange${r}`)}
              </Btn>
            ))}
          </div>
          {hosts.length > 1 && (
            <Select
              value={hostSel === ALL || hosts.includes(hostSel) ? hostSel : ALL}
              onChange={setHostSel}
              options={hostOptions}
              ariaLabel={t("apps.analyticsDomain")}
              placeholder={t("apps.analyticsDomain")}
              style={{ marginLeft: "auto", minWidth: 180, maxWidth: "100%", flex: "0 1 280px" }}
            />
          )}
        </div>
      )}
      {body}
    </div>
  );
}
