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

/** App "Metrics" tab: per-container CPU/RAM/Net/Disk charts, range-switchable, auto-refreshing.
 *  Read-level (metrics carry no secrets) — visible to every team member. */
export function AppMetricsCard({ id }: { id: string }) {
  const t = useT();
  const [range, setRange] = useState<MetricsRange>("1h");
  const { data, isLoading, isError } = useQuery({
    queryKey: ["appContainerMetrics", id, range],
    queryFn: () => api.getAppContainerMetrics(id, range),
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
      <div className="mono" style={{ fontSize: 12, color: "var(--c-tx2)", marginBottom: 10, wordBreak: "break-all" }}>{name}</div>
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
