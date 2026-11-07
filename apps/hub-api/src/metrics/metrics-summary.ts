import type { HostMetricPoint } from "./metrics.service";
import type { ContainerMetricSample } from "./container-metrics.service";

/** Current / average / peak of one metric over a window (null when there is no data). */
export interface MetricStat {
  current: number | null;
  avg: number | null;
  max: number | null;
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const fin = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** Reduce a series to current (last) / avg / max. `peaks` (e.g. the per-minute max cpu of a rollup read)
 *  widens `max` when present so a long-range summary reports real spikes, not just the average's peak. */
export function statOf(values: number[], peaks?: number[]): MetricStat {
  const v = values.filter(fin);
  if (v.length === 0) return { current: null, avg: null, max: null };
  const p = (peaks ?? []).filter(fin);
  return {
    current: r1(v[v.length - 1]),
    avg: r1(v.reduce((a, b) => a + b, 0) / v.length),
    max: r1(Math.max(...v, ...p)),
  };
}

const pctOf = (used: number, total: number): number | null => (fin(used) && fin(total) && total > 0 ? (used / total) * 100 : null);

/** Disk-usage % history series (one value per sample that has a usable total) — diskUsed/diskTotal are
 *  already stored on every raw row + rollup bucket, so no schema change is needed. */
export function diskPctSeries(samples: Pick<HostMetricPoint, "ts" | "diskUsed" | "diskTotal">[]): { ts: number; pct: number }[] {
  const out: { ts: number; pct: number }[] = [];
  for (const s of samples) {
    const p = pctOf(s.diskUsed, s.diskTotal);
    if (p !== null) out.push({ ts: s.ts, pct: p });
  }
  return out;
}

/** Compact host summary for the MCP get_server_metrics tool: current + range avg/max for cpu / mem % / disk %. */
export function summarizeHost(range: string, samples: HostMetricPoint[]) {
  const mem = samples.map((s) => pctOf(s.memUsed, s.memTotal)).filter(fin);
  return {
    range,
    samples: samples.length,
    from: samples.length ? new Date(samples[0].ts).toISOString() : null,
    to: samples.length ? new Date(samples[samples.length - 1].ts).toISOString() : null,
    cpu: statOf(samples.map((s) => s.cpu), samples.map((s) => s.cpuMax as number)),
    mem: statOf(mem),
    disk: statOf(diskPctSeries(samples).map((d) => d.pct)),
  };
}

/** Compact per-container summary for the MCP get_container_metrics tool (cpu / mem % + avg network rates). */
export function summarizeContainer(name: string, samples: ContainerMetricSample[]) {
  return {
    name,
    samples: samples.length,
    cpu: statOf(samples.map((s) => s.cpu), samples.map((s) => s.cpuMax as number)),
    mem: statOf(samples.map((s) => s.memPct)),
    netRxBytesPerSec: statOf(samples.map((s) => s.netRx)),
    netTxBytesPerSec: statOf(samples.map((s) => s.netTx)),
  };
}
