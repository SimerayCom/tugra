"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { BarChart3 } from "lucide-react";
import { api } from "../../../lib/api";
import { fmtBytes } from "../../../lib/fleet";
import { botShare, breakdownShares, bucketIntervalMs, countryName, countryShares, errorRatePct, humanizeBytesSeries, trafficIsEmpty } from "../../../lib/traffic";
import type { MetricsRange, TrafficBreakdownDim, TrafficPaths, TrafficSummary } from "../../../lib/types";
import { useI18n } from "../../../i18n/provider";
import { useTeamScope } from "../../../components/team-scope";
import { Btn, Card, EmptyState, Spinner } from "../../../components/ui";
import { ErrorState } from "../../../components/error-state";
import { Select } from "../../../components/form";
import { PageTitle } from "../../../components/page-header";
import { ChartCard, MetricChart, Sparkline, ToggleButton, METRIC_GRID_STYLE, METRIC_CHART_HEIGHT, type ChartSeries } from "../../../components/charts";

const RANGES: MetricsRange[] = ["1h", "6h", "24h", "7d", "30d"];
const ALL = "__all__"; // <Select> reserves "" for its disabled placeholder, so "all domains" gets a sentinel
const POLL_MS = 60_000; // access-log aggregates move slowly; no need to hammer the hub
const TOP_LIMIT = 20;
const BREAKDOWN_LIMIT = 20;
const BREAKDOWN_DIMS: { dim: TrafficBreakdownDim; labelKey: string }[] = [
  { dim: "browser", labelKey: "traffic.dimBrowser" },
  { dim: "os", labelKey: "traffic.dimOs" },
  { dim: "device", labelKey: "traffic.dimDevice" },
  { dim: "referrer", labelKey: "traffic.dimReferrer" },
  { dim: "city", labelKey: "traffic.dimCity" },
  { dim: "network", labelKey: "traffic.dimNetwork" },
];
// Placeholder keys the hub/agent emit for "no value" buckets, shown as localized labels.
const BREAKDOWN_KEY_LABELS: Record<string, string> = {
  "(other)": "traffic.keyFolded",
  "(direct)": "traffic.keyDirect",
  "(unmatched)": "traffic.keyUnmatched",
  "(unknown)": "traffic.keyUnknown",
};
// The agent emits its own raw labels: lowercase device classes, and the literal "Other" for unrecognised browsers/OSes.
const DEVICE_KEY_LABELS: Record<string, string> = {
  desktop: "traffic.deviceDesktop",
  mobile: "traffic.deviceMobile",
  tablet: "traffic.deviceTablet",
  bot: "traffic.deviceBot",
  other: "traffic.deviceOther",
};
const AGENT_OTHER_DIMS: TrafficBreakdownDim[] = ["browser", "os"];
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
          {summary.data && <StatTiles summary={summary.data} />}
          {summary.data && <TrafficCharts summary={summary.data} />}
          <BreakdownCard dim={dim} onDim={setDim} range={range} teamId={teamId} domain={domain} />
          <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 420px), 1fr))", alignItems: "start" }}>
            <PathsTable data={paths.data} />
            <CountriesList rows={countries.data?.countries ?? []} totalRequests={summary.data?.totals.requests} lang={lang} />
          </div>
        </div>
      )}
    </div>
  );
}

function StatTiles({ summary }: { summary: TrafficSummary }) {
  const { t } = useI18n();
  const totals = summary.totals;
  const errors = totals.s4xx + totals.s5xx;
  const tiles = [
    { label: t("traffic.statRequests"), value: nf.format(totals.requests) },
    { label: t("traffic.statBytes"), value: fmtBytes(totals.bytes) },
    { label: t("traffic.statErrors"), value: nf.format(errors) },
    { label: t("traffic.statErrorRate"), value: `${errorRatePct(totals).toFixed(1)}%` },
  ];
  const p95 = Number.isFinite(totals.p95Ms) && totals.p95Ms > 0 ? totals.p95Ms : 0; // 0 = no latency data
  // Buckets without latency data (0) are not real 0 ms readings: NaN leaves a gap, placed by time like the big chart.
  const p95Spark = useMemo(() => (summary.p95Ms ?? []).map((v) => (Number.isFinite(v) && v > 0 ? v : NaN)), [summary.p95Ms]);
  const p95Interval = bucketIntervalMs(summary);
  const bots = botShare(totals);
  const tileStyle = { fontSize: 20, fontWeight: 700, color: "var(--c-tx)", fontVariantNumeric: "tabular-nums" } as const;
  return (
    <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 150px), 1fr))" }}>
      {tiles.map((x) => (
        <Card key={x.label} style={{ padding: 14 }}>
          <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 4 }}>{x.label}</div>
          <div className="mono" style={tileStyle}>{x.value}</div>
        </Card>
      ))}
      <Card key="p95" style={{ padding: 14 }}>
        <div title={t("traffic.statP95Hint")} style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 4 }}>{t("traffic.statP95")}</div>
        {p95 > 0 ? (
          <>
            <div className="mono" style={tileStyle}>{`${nf.format(Math.round(p95))} ms`}</div>
            {p95Spark.filter((v) => Number.isFinite(v)).length >= 2 && (
              <div style={{ marginTop: 6 }}>
                <Sparkline data={p95Spark} times={summary.times} interval={p95Interval} width={110} height={22} color="var(--c-lapis)" label={t("traffic.chartP95")} />
              </div>
            )}
          </>
        ) : (
          <div style={{ fontSize: 13, color: "var(--c-tx3)" }}>{t("traffic.statP95None")}</div>
        )}
      </Card>
      <Card key="bots" style={{ padding: 14 }}>
        <div title={t("traffic.statBotsHint")} style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 4 }}>{t("traffic.statBots")}</div>
        {bots.classified > 0 ? (
          <>
            <div className="mono" style={tileStyle}>{`${bots.botPct.toFixed(1)}%`}</div>
            <div style={{ fontSize: 11, color: "var(--c-tx3)", marginTop: 4 }}>
              {t("traffic.statBotsDetail", { human: nf.format(totals.humanRequests), bot: nf.format(totals.botRequests) })}
            </div>
          </>
        ) : (
          <div style={{ fontSize: 13, color: "var(--c-tx3)" }}>{t("traffic.statBotsNone")}</div>
        )}
      </Card>
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
  // 0 = "no latency data" for that bucket, not a 0 ms reading: NaN makes the chart leave a gap instead of a false dip.
  const p95 = useMemo(() => (summary.p95Ms ?? []).map((v) => (Number.isFinite(v) && v > 0 ? v : NaN)), [summary.p95Ms]);
  const hasP95 = p95.some((v) => Number.isFinite(v));
  return (
    <div style={METRIC_GRID_STYLE}>
      <TableChartCard title={t("traffic.chartRequests")} description={t("traffic.chartRequestsDesc")}>
        {(tableView) => (
          <MetricChart
            bare
            hideHeader
            tableView={tableView}
            height={METRIC_CHART_HEIGHT}
            label={t("traffic.chartRequests")}
            times={summary.times}
            interval={interval}
            unit=""
            series={[{ key: "requests", label: t("traffic.seriesRequests"), values: summary.requests, color: "var(--c-a)", kind: "area" }]}
          />
        )}
      </TableChartCard>
      <TableChartCard title={t("traffic.chartStatus")} description={t("traffic.chartStatusDesc")}>
        {(tableView) => (
          <MetricChart bare tableView={tableView} height={METRIC_CHART_HEIGHT} label={t("traffic.chartStatus")} times={summary.times} interval={interval} unit="" series={statusSeries} />
        )}
      </TableChartCard>
      <TableChartCard title={t("traffic.chartBandwidth")} description={t("traffic.chartBandwidthDesc")}>
        {(tableView) => (
          <MetricChart
            bare
            hideHeader
            tableView={tableView}
            height={METRIC_CHART_HEIGHT}
            label={t("traffic.chartBandwidth")}
            times={summary.times}
            interval={interval}
            unit={" " + bytes.unit}
            decimals={1}
            series={[{ key: "bytes", label: t("traffic.seriesBandwidth"), values: bytes.data, color: "var(--c-lapis)", kind: "area" }]}
          />
        )}
      </TableChartCard>
      {hasP95 && (
        <TableChartCard title={t("traffic.chartP95")} description={t("traffic.chartP95Desc")}>
          {(tableView) => (
            <MetricChart
              bare
              hideHeader
              tableView={tableView}
              height={METRIC_CHART_HEIGHT}
              label={t("traffic.chartP95")}
              times={summary.times}
              interval={interval}
              unit=" ms"
              series={[{ key: "p95", label: t("traffic.seriesP95"), values: p95, color: "var(--c-am)", kind: "area" }]}
            />
          )}
        </TableChartCard>
      )}
    </div>
  );
}

/** A ChartCard whose corner holds a "View as table" toggle: the chart's own header (and so its built-in toggle) is
 *  hidden here, so the card owns the state and passes it down. Gives every chart a text alternative. */
function TableChartCard({ title, description, children }: { title: string; description: string; children: (tableView: boolean) => ReactNode }) {
  const { t } = useI18n();
  const [tableView, setTableView] = useState(false);
  return (
    <ChartCard
      title={title}
      description={description}
      controls={
        <ToggleButton pressed={tableView} onClick={() => setTableView((v) => !v)} label={`${t("charts.viewAsTable")}: ${title}`}>
          {t("charts.table")}
        </ToggleButton>
      }
    >
      {children(tableView)}
    </ChartCard>
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
        <ul
          tabIndex={0}
          role="region"
          aria-label={t("traffic.countriesList")}
          style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 10, maxHeight: 480, overflowY: "auto" }}
        >
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

/** Visitor breakdown: a segmented control picks ONE dimension (browser/os/device/referrer/city/network) and only that
 *  dimension is fetched; rows are ranked with a proportional bar. */
function BreakdownCard({ dim, onDim, range, teamId, domain }: { dim: TrafficBreakdownDim; onDim: (d: TrafficBreakdownDim) => void; range: MetricsRange; teamId: string | null | undefined; domain: string | undefined }) {
  const { t } = useI18n();
  const q = useQuery({
    queryKey: ["trafficBreakdown", teamId, range, domain, dim],
    queryFn: () => api.getTrafficBreakdown(dim, { range, teamId, domain, limit: BREAKDOWN_LIMIT }),
    refetchInterval: POLL_MS,
  });
  // Shares: out of the returned items PLUS the folded "(other)" overflow, see breakdownShares().
  const rows = useMemo(() => breakdownShares(q.data?.items ?? [], q.data?.other.requests ?? 0), [q.data]);
  const dimLabel = t(BREAKDOWN_DIMS.find((d) => d.dim === dim)!.labelKey);
  const keyLabel = (key: string) => {
    if (BREAKDOWN_KEY_LABELS[key]) return t(BREAKDOWN_KEY_LABELS[key]);
    if (dim === "device" && DEVICE_KEY_LABELS[key]) return t(DEVICE_KEY_LABELS[key]);
    if (key === "Other" && AGENT_OTHER_DIMS.includes(dim)) return t("traffic.keyOther");
    return key || t("traffic.keyUnknown");
  };
  return (
    <ChartCard title={t("traffic.breakdownTitle")} description={t("traffic.breakdownDesc")}>
      <div role="group" aria-label={t("traffic.breakdownDim")} style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
        {BREAKDOWN_DIMS.map((d) => (
          <Btn key={d.dim} variant={d.dim === dim ? "primary" : "ghost"} aria-pressed={d.dim === dim} onClick={() => onDim(d.dim)}>
            {t(d.labelKey)}
          </Btn>
        ))}
      </div>
      {q.isLoading ? (
        <div style={{ display: "flex", justifyContent: "center", padding: 8 }}><Spinner /></div>
      ) : q.isError ? (
        <ErrorState onRetry={() => q.refetch()} />
      ) : rows.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--c-tx3)" }}>{t("traffic.breakdownEmpty", { dim: dimLabel.toLowerCase() })}</div>
      ) : (
        <ul
          tabIndex={0}
          role="region"
          aria-label={`${t("traffic.breakdownTitle")}: ${dimLabel}`}
          style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 10, maxHeight: 480, overflowY: "auto" }}
        >
          {rows.map((r) => (
            <li key={r.isOther ? "(other)" : r.key} data-testid="traffic-breakdown-row">
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 13, marginBottom: 4 }}>
                <span style={{ color: r.isOther ? "var(--c-tx3)" : "var(--c-tx)", fontStyle: r.isOther ? "italic" : undefined, minWidth: 0, wordBreak: "break-word" }}>
                  {keyLabel(r.key)}
                </span>
                <span className="mono" style={{ color: "var(--c-tx2)", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                  {t("traffic.breakdownRow", { n: nf.format(r.requests), pct: r.pct.toFixed(1) })}
                </span>
              </div>
              <div aria-hidden="true" style={{ height: 6, borderRadius: 3, background: "var(--c-el)", overflow: "hidden" }}>
                <div data-testid="traffic-breakdown-bar" style={{ width: `${r.pct}%`, height: "100%", background: r.isOther ? "var(--c-tx3)" : "var(--c-a)" }} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </ChartCard>
  );
}
