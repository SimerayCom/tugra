"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BarChart3 } from "lucide-react";
import { api } from "../../../lib/api";
import { fmtBytes } from "../../../lib/fleet";
import { bucketIntervalMs, countryName, countryShares, errorRatePct, humanizeBytesSeries, trafficIsEmpty } from "../../../lib/traffic";
import type { MetricsRange, TrafficPaths, TrafficSummary } from "../../../lib/types";
import { useI18n } from "../../../i18n/provider";
import { useTeamScope } from "../../../components/team-scope";
import { Btn, Card, EmptyState, Spinner } from "../../../components/ui";
import { ErrorState } from "../../../components/error-state";
import { Select } from "../../../components/form";
import { PageTitle } from "../../../components/page-header";
import { ChartCard, MetricChart, METRIC_GRID_STYLE, METRIC_CHART_HEIGHT, type ChartSeries } from "../../../components/charts";

const RANGES: MetricsRange[] = ["1h", "6h", "24h", "7d", "30d"];
const ALL = "__all__"; // <Select> reserves "" for its disabled placeholder, so "all domains" gets a sentinel
const POLL_MS = 60_000; // access-log aggregates move slowly; no need to hammer the hub
const TOP_LIMIT = 20;
const COUNTRY_LIMIT = 250; // hub maximum, so the tail beyond the default top set is not silently dropped from the shares

const nf = new Intl.NumberFormat("en-US");

/** Traffic Analytics: visitor requests, status classes, bandwidth, top paths and countries from the proxy's
 *  local access log, scoped to the global team selector and (optionally) one domain. */
export default function TrafficPage() {
  const { t, lang } = useI18n();
  const { teamId } = useTeamScope();
  const [range, setRange] = useState<MetricsRange>("24h");
  const [domainSel, setDomainSel] = useState(ALL);
  const domain = domainSel === ALL ? undefined : domainSel;

  const domains = useQuery({
    queryKey: ["trafficDomains", teamId, range],
    queryFn: () => api.getTrafficDomains({ range, teamId }),
    refetchInterval: POLL_MS,
  });
  // A domain that is no longer in the (team/range-scoped) list falls back to "all domains".
  useEffect(() => {
    if (domainSel !== ALL && domains.data && !domains.data.some((d) => d.domain === domainSel)) setDomainSel(ALL);
  }, [domains.data, domainSel]);

  const summary = useQuery({
    queryKey: ["trafficSummary", teamId, range, domain],
    queryFn: () => api.getTrafficSummary({ range, teamId, domain }),
    refetchInterval: POLL_MS,
  });
  const paths = useQuery({
    queryKey: ["trafficPaths", teamId, range, domain],
    queryFn: () => api.getTrafficPaths({ range, teamId, domain, limit: TOP_LIMIT }),
    refetchInterval: POLL_MS,
  });
  const countries = useQuery({
    queryKey: ["trafficCountries", teamId, range, domain],
    queryFn: () => api.getTrafficCountries({ range, teamId, domain, limit: COUNTRY_LIMIT }),
    refetchInterval: POLL_MS,
  });

  const loading = summary.isLoading || paths.isLoading || countries.isLoading;
  const failed = summary.isError && paths.isError && countries.isError;
  const empty = trafficIsEmpty(summary.data, paths.data, countries.data);

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
          <ErrorState onRetry={() => { summary.refetch(); paths.refetch(); countries.refetch(); }} />
        </Card>
      ) : loading ? (
        <Card style={{ padding: 16, display: "flex", justifyContent: "center" }}><Spinner /></Card>
      ) : empty ? (
        <Card style={{ padding: 16 }}>
          <EmptyState
            icon={BarChart3}
            title={t("traffic.emptyTitle")}
            action={<Link href="/servers" className="tg-link" style={{ fontSize: 13 }}>{t("traffic.emptyAction")}</Link>}
          >
            {t("traffic.emptyBody")}
          </EmptyState>
        </Card>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {summary.data && <StatTiles totals={summary.data.totals} />}
          {summary.data && <TrafficCharts summary={summary.data} />}
          <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 420px), 1fr))", alignItems: "start" }}>
            <PathsTable data={paths.data} />
            <CountriesList rows={countries.data?.countries ?? []} totalRequests={summary.data?.totals.requests} lang={lang} />
          </div>
        </div>
      )}
    </div>
  );
}

function StatTiles({ totals }: { totals: { requests: number; bytes: number; s4xx: number; s5xx: number } }) {
  const { t } = useI18n();
  const errors = totals.s4xx + totals.s5xx;
  const tiles = [
    { label: t("traffic.statRequests"), value: nf.format(totals.requests) },
    { label: t("traffic.statBytes"), value: fmtBytes(totals.bytes) },
    { label: t("traffic.statErrors"), value: nf.format(errors) },
    { label: t("traffic.statErrorRate"), value: `${errorRatePct(totals).toFixed(1)}%` },
  ];
  return (
    <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 150px), 1fr))" }}>
      {tiles.map((x) => (
        <Card key={x.label} style={{ padding: 14 }}>
          <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 4 }}>{x.label}</div>
          <div className="mono" style={{ fontSize: 20, fontWeight: 700, color: "var(--c-tx)", fontVariantNumeric: "tabular-nums" }}>{x.value}</div>
        </Card>
      ))}
    </div>
  );
}

function TrafficCharts({ summary }: { summary: TrafficSummary }) {
  const { t } = useI18n();
  const interval = bucketIntervalMs(summary);
  const bytes = useMemo(() => humanizeBytesSeries(summary.bytes), [summary.bytes]);
  // Explicit colours: the 4 status classes carry meaning (good → bad), so they must not fall to the slot palette.
  const statusSeries: ChartSeries[] = [
    { key: "s2xx", label: t("traffic.status2xx"), values: summary.s2xx, color: "var(--c-g)", kind: "stacked" },
    { key: "s3xx", label: t("traffic.status3xx"), values: summary.s3xx, color: "var(--c-lapis)", kind: "stacked" },
    { key: "s4xx", label: t("traffic.status4xx"), values: summary.s4xx, color: "var(--c-am)", kind: "stacked" },
    { key: "s5xx", label: t("traffic.status5xx"), values: summary.s5xx, color: "var(--c-r)", kind: "stacked" },
  ];
  return (
    <div style={METRIC_GRID_STYLE}>
      <ChartCard title={t("traffic.chartRequests")} description={t("traffic.chartRequestsDesc")}>
        <MetricChart
          bare
          hideHeader
          height={METRIC_CHART_HEIGHT}
          label={t("traffic.chartRequests")}
          times={summary.times}
          interval={interval}
          unit=""
          series={[{ key: "requests", label: t("traffic.seriesRequests"), values: summary.requests, color: "var(--c-a)", kind: "area" }]}
        />
      </ChartCard>
      <ChartCard title={t("traffic.chartStatus")} description={t("traffic.chartStatusDesc")}>
        <MetricChart bare height={METRIC_CHART_HEIGHT} label={t("traffic.chartStatus")} times={summary.times} interval={interval} unit="" series={statusSeries} />
      </ChartCard>
      <ChartCard title={t("traffic.chartBandwidth")} description={t("traffic.chartBandwidthDesc")}>
        <MetricChart
          bare
          hideHeader
          height={METRIC_CHART_HEIGHT}
          label={t("traffic.chartBandwidth")}
          times={summary.times}
          interval={interval}
          unit={" " + bytes.unit}
          decimals={1}
          series={[{ key: "bytes", label: t("traffic.seriesBandwidth"), values: bytes.data, color: "var(--c-lapis)", kind: "area" }]}
        />
      </ChartCard>
    </div>
  );
}

const cellBase = { padding: "7px 10px", borderBottom: "1px solid var(--c-bd)", fontSize: 13 } as const;

function PathsTable({ data }: { data: TrafficPaths | undefined }) {
  const { t } = useI18n();
  const rows = data?.paths ?? [];
  const other = data?.other;
  return (
    <ChartCard title={t("traffic.topPaths")}>
      {rows.length === 0 && !(other && other.requests > 0) ? (
        <div style={{ fontSize: 13, color: "var(--c-tx3)" }}>{t("traffic.noPaths")}</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ color: "var(--c-tx3)", fontSize: 11, textAlign: "left" }}>
                <th scope="col" style={{ ...cellBase, fontWeight: 600 }}>{t("traffic.colPath")}</th>
                <th scope="col" style={{ ...cellBase, fontWeight: 600, textAlign: "right" }}>{t("traffic.colRequests")}</th>
                <th scope="col" style={{ ...cellBase, fontWeight: 600, textAlign: "right" }}>{t("traffic.colBytes")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.path}>
                  <td className="mono" style={{ ...cellBase, wordBreak: "break-all", color: "var(--c-tx)" }}>{p.path}</td>
                  <td style={{ ...cellBase, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{nf.format(p.requests)}</td>
                  <td style={{ ...cellBase, textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{fmtBytes(p.bytes)}</td>
                </tr>
              ))}
              {other && other.requests > 0 && (
                <tr style={{ color: "var(--c-tx3)" }}>
                  <td style={{ ...cellBase, fontStyle: "italic" }}>{t("traffic.otherPaths")}</td>
                  <td style={{ ...cellBase, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{nf.format(other.requests)}</td>
                  <td style={{ ...cellBase, textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{fmtBytes(other.bytes)}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </ChartCard>
  );
}

function CountriesList({ rows, totalRequests, lang }: { rows: { country: string; requests: number }[]; totalRequests: number | undefined; lang: string }) {
  const { t } = useI18n();
  // Percentages are shares of the requests with a known country (sum of these rows), see countryShares().
  const shares = useMemo(() => countryShares(rows), [rows]);
  // Requests never attributed to a country (no GeoIP data, private IPs) are absent from `rows`; surface the coverage gap.
  const located = useMemo(() => shares.reduce((n, c) => (c.country === "ZZ" ? n : n + c.requests), 0), [shares]);
  const showCoverage = totalRequests !== undefined && Number.isFinite(totalRequests) && totalRequests > located;
  return (
    <ChartCard title={t("traffic.countries")} description={t("traffic.countriesDesc")}>
      {shares.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--c-tx3)" }}>{t("traffic.noCountries")}</div>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 10, maxHeight: 480, overflowY: "auto" }}>
          {shares.map((c) => {
            const name = countryName(c.country, lang) ?? t("traffic.otherCountry");
            return (
              <li key={c.country} data-testid="traffic-country">
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 13, marginBottom: 4 }}>
                  <span style={{ color: "var(--c-tx)", minWidth: 0, wordBreak: "break-word" }}>{name}</span>
                  <span className="mono" style={{ color: "var(--c-tx2)", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                    {nf.format(c.requests)} · {c.pct.toFixed(1)}%
                  </span>
                </div>
                <div aria-hidden="true" style={{ height: 6, borderRadius: 3, background: "var(--c-el)", overflow: "hidden" }}>
                  <div data-testid="traffic-country-bar" style={{ width: `${c.pct}%`, height: "100%", background: "var(--c-a)" }} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {showCoverage && (
        <p style={{ fontSize: 11, color: "var(--c-tx3)", margin: "12px 0 0" }}>
          {t("traffic.countriesCoverage", { located: nf.format(located), total: nf.format(totalRequests) })}
        </p>
      )}
    </ChartCard>
  );
}
