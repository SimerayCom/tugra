"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import type { MetricsRange, TrafficBreakdownDim } from "../../../lib/types";
import { useI18n } from "../../../i18n/provider";
import { useTeamScope } from "../../../components/team-scope";
import { Btn, Card, Spinner } from "../../../components/ui";
import { TrafficEnablePanel } from "../../../components/traffic-enable-panel";
import { ErrorState } from "../../../components/error-state";
import { Select } from "../../../components/form";
import { PageTitle } from "../../../components/page-header";
import { BreakdownCard, CountriesList, PathsTable, StatTiles, TrafficCharts, POLL_MS, nf } from "../../../components/traffic/traffic-panels";
import { useTrafficData } from "../../../hooks/useTrafficData";

const RANGES: MetricsRange[] = ["1h", "6h", "24h", "7d", "30d"];
const ALL = "__all__"; // <Select> reserves "" for its disabled placeholder, so "all domains" gets a sentinel

/** Traffic Analytics: visitor requests, status classes, bandwidth, top paths and countries from the proxy's
 *  local access log, scoped to the global team selector and (optionally) one domain. */
export default function TrafficPage() {
  const { t, lang } = useI18n();
  const { teamId } = useTeamScope();
  const [range, setRange] = useState<MetricsRange>("24h");
  const [domainSel, setDomainSel] = useState(ALL);
  const domain = domainSel === ALL ? undefined : domainSel;
  // Lives on the page (not in the card): a range/domain change swaps the body for a spinner and would otherwise reset it.
  const [dim, setDim] = useState<TrafficBreakdownDim>("browser");

  const domains = useQuery({
    queryKey: ["trafficDomains", teamId, range],
    queryFn: () => api.getTrafficDomains({ range, teamId }),
    refetchInterval: POLL_MS,
  });
  // A domain that is no longer in the (team/range-scoped) list falls back to "all domains".
  useEffect(() => {
    if (domainSel !== ALL && domains.data && !domains.data.some((d) => d.domain === domainSel)) setDomainSel(ALL);
  }, [domains.data, domainSel]);

  const { summary, paths, countries, loading, failed, empty, refetch } = useTrafficData({ range, teamId, domain });

  const domainOptions = [
    { value: ALL, label: t("traffic.allDomains") },
    ...(domains.data ?? []).map((d) => ({ value: d.domain, label: t("traffic.domainOption", { domain: d.domain, n: nf.format(d.requests) }) })),
  ];

  return (
    <div style={{ padding: "var(--page-pad)" }}>
      <PageTitle title={t("traffic.title")} subtitle={t("traffic.subtitle")} />

      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        <div role="group" aria-label={t("traffic.range")} style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {RANGES.map((r) => (
            <Btn key={r} variant={r === range ? "primary" : "ghost"} aria-pressed={r === range} onClick={() => setRange(r)}>
              {t(`apps.metricsRange${r}`)}
            </Btn>
          ))}
        </div>
        <Select
          value={domainSel}
          onChange={setDomainSel}
          options={domainOptions}
          ariaLabel={t("traffic.domain")}
          placeholder={t("traffic.domain")}
          style={{ marginLeft: "auto", minWidth: 180, maxWidth: "100%", flex: "0 1 280px" }}
        />
      </div>

      {failed ? (
        <Card style={{ padding: 16 }}>
          <ErrorState onRetry={refetch} />
        </Card>
      ) : loading ? (
        <Card style={{ padding: 16, display: "flex", justifyContent: "center" }}><Spinner /></Card>
      ) : empty ? (
        <Card style={{ padding: 16 }}>
          <TrafficEnablePanel teamId={teamId} />
        </Card>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {summary.data && <StatTiles summary={summary.data} />}
          {summary.data && <TrafficCharts summary={summary.data} />}
          <BreakdownCard dim={dim} onDim={setDim} range={range} teamId={teamId} domain={domain} />
          <CountriesList rows={countries.data?.countries ?? []} totalRequests={summary.data?.totals.requests} lang={lang} />
          <PathsTable data={paths.data} />
        </div>
      )}
    </div>
  );
}
