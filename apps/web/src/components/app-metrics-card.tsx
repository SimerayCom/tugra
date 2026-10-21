"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { humanizeRateSeries } from "../lib/metrics";
import type { MetricsRange, ContainerMetricSample } from "../lib/types";
import { useT } from "../i18n/provider";
import { Btn, Card, EmptyState, Spinner } from "./ui";
import { MetricChart } from "./charts";

const METRIC_RANGES: MetricsRange[] = ["1h", "6h", "24h", "7d"];

/** "Metrics" tab: per-container CPU/RAM/Net/Disk charts, range-switchable, auto-refreshing.
 *  Serves both applications and databases (`kind`) — the agent samples every container, so the chart
 *  data differs only by which resource endpoint it reads. Read-level (metrics carry no secrets). */
export function AppMetricsCard({ id, kind = "app" }: { id: string; kind?: "app" | "database" }) {
  const t = useT();
  const [range, setRange] = useState<MetricsRange>("1h");
  const { data, isLoading, isError } = useQuery({
    queryKey: [kind === "database" ? "databaseContainerMetrics" : "appContainerMetrics", id, range],
    queryFn: () => (kind === "database" ? api.getDatabaseContainerMetrics(id, range) : api.getAppContainerMetrics(id, range)),
    refetchInterval: 5000,
  });
  const containers = data?.containers ?? [];

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        <div style={{ fontWeight: 600, flex: 1 }}>{t("apps.tabMetrics")}</div>
        {METRIC_RANGES.map((r) => (
          <Btn key={r} variant={r === range ? "primary" : "ghost"} onClick={() => setRange(r)}>
            {t(`apps.metricsRange${r}`)}
          </Btn>
        ))}
      </div>
      {isError ? (
        <Card style={{ padding: 16 }}><EmptyState>{t("apps.noMetrics")}</EmptyState></Card>
      ) : isLoading && containers.length === 0 ? (
        <Card style={{ padding: 16, display: "flex", justifyContent: "center" }}><Spinner /></Card>
      ) : containers.length === 0 ? (
        <Card style={{ padding: 16 }}><EmptyState>{t("apps.noMetrics")}</EmptyState></Card>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          {containers.map((c) => (
            <ContainerMetricsSection key={c.name} name={c.name} samples={c.samples} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Strip the `tugra_<id>-` project prefix + `-<n>` replica suffix so a container reads as its
 *  compose service ("wordpress", "db") instead of the raw `tugra_<cuid>-wordpress-1`. */
function friendlyContainer(name: string): string {
  const m = /^tugra_[a-z0-9]+-(.+)-\d+$/i.exec(name);
  if (m) return m[1];
  if (/^tugra_[a-z0-9]+$/i.test(name)) return "container";
  return name;
}

function ContainerMetricsSection({ name, samples }: { name: string; samples: ContainerMetricSample[] }) {
  const t = useT();
  const cpu = samples.map((s) => s.cpu);
  const ram = samples.map((s) => s.memPct);
  const netIn = humanizeRateSeries(samples.map((s) => s.netRx));
  const netOut = humanizeRateSeries(samples.map((s) => s.netTx));
  const blkRead = humanizeRateSeries(samples.map((s) => s.blkRead));
  const blkWrite = humanizeRateSeries(samples.map((s) => s.blkWrite));
  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--c-tx)", marginBottom: 10, wordBreak: "break-all" }} title={name}>{friendlyContainer(name)}</div>
      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
        <MetricChart data={cpu} label={t("apps.metricsCpu")} unit="%" color="var(--c-a)" />
        <MetricChart data={ram} label={t("apps.metricsRam")} unit="%" color="var(--c-lapis)" decimals={1} />
        <MetricChart data={netIn.data} label={t("apps.metricsNetIn")} unit={" " + netIn.unit} color="var(--c-g)" decimals={1} />
        <MetricChart data={netOut.data} label={t("apps.metricsNetOut")} unit={" " + netOut.unit} color="var(--c-am)" decimals={1} />
        <MetricChart data={blkRead.data} label={t("apps.metricsBlkRead")} unit={" " + blkRead.unit} color="var(--c-lapis)" decimals={1} />
        <MetricChart data={blkWrite.data} label={t("apps.metricsBlkWrite")} unit={" " + blkWrite.unit} color="var(--c-am)" decimals={1} />
      </div>
    </div>
  );
}
