"use client";

import { useQuery } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import { api } from "../lib/api";
import { useT } from "../i18n/provider";
import { Btn, Card } from "./ui";
import { MeterBar } from "./meter-bar";
import { pct, fmtBytes } from "../lib/fleet";
import { metricTone, tempTone, batteryTone, FLEET_STALE_MS, type MetricTone } from "../lib/fleet-view";
import type { MetricsSample } from "../lib/types";

/** A finite number or null — one bad field degrades to "—" instead of crashing the gauge row. */
const fin = (n: unknown): number | null => (typeof n === "number" && Number.isFinite(n) ? n : null);

interface Gauge {
  key: string;
  label: string;
  value: number | null; // 0..100 bar fill (temperature is shown on a 0..100 °C scale)
  tone: MetricTone;
  text: string;
}

/** Build the gauge rows from one sample. CPU/mem/disk always; temperature, each GPU and battery
 *  only when the host reported them (most cloud VMs expose none of the three). Exported for testing. */
export function buildGauges(s: MetricsSample, t: (k: string, v?: Record<string, string | number>) => string): Gauge[] {
  const rows: Gauge[] = [];
  const cpu = fin(s.cpu);
  rows.push({ key: "cpu", label: t("servers.cpu"), value: cpu, tone: metricTone(cpu), text: cpu === null ? "—" : `${Math.round(cpu)}%` });

  const memUsed = fin(s.memUsed);
  const memTotal = fin(s.memTotal);
  const memPct = memUsed !== null && memTotal !== null && memTotal > 0 ? pct(memUsed, memTotal) : null;
  rows.push({
    key: "mem",
    label: t("servers.ram"),
    value: memPct,
    tone: metricTone(memPct),
    text: memPct === null ? "—" : `${Math.round(memPct)}%${memTotal ? ` · ${fmtBytes(memUsed ?? 0)}/${fmtBytes(memTotal)}` : ""}`,
  });

  // Swap only when the host actually has some — a swapless host (swapTotal 0/absent) shows no gauge.
  const swapUsed = fin(s.swapUsed);
  const swapTotal = fin(s.swapTotal);
  if (swapTotal !== null && swapTotal > 0) {
    const swapPct = swapUsed !== null ? pct(swapUsed, swapTotal) : null;
    rows.push({
      key: "swap",
      label: t("servers.swap"),
      value: swapPct,
      tone: metricTone(swapPct),
      text: swapPct === null ? "—" : `${Math.round(swapPct)}% · ${fmtBytes(swapUsed ?? 0)}/${fmtBytes(swapTotal)}`,
    });
  }

  const diskUsed = fin(s.diskUsed);
  const diskTotal = fin(s.diskTotal);
  const diskPct = diskUsed !== null && diskTotal !== null && diskTotal > 0 ? pct(diskUsed, diskTotal) : null;
  rows.push({
    key: "disk",
    label: t("servers.diskUsage"),
    value: diskPct,
    tone: metricTone(diskPct),
    text: diskPct === null ? "—" : `${Math.round(diskPct)}%${diskTotal ? ` · ${fmtBytes(diskUsed ?? 0)}/${fmtBytes(diskTotal)}` : ""}`,
  });

  const temp = fin(s.temp);
  if (temp !== null) {
    rows.push({ key: "temp", label: t("servers.temp"), value: Math.min(100, temp), tone: tempTone(temp), text: `${Math.round(temp)}°C` });
  }

  const gpus = Array.isArray(s.gpus) ? s.gpus : [];
  gpus.forEach((g, i) => {
    const util = fin(g?.util);
    const gTemp = fin(g?.temp);
    const gMemUsed = fin(g?.memUsed);
    const gMemTotal = fin(g?.memTotal);
    const parts = [util === null ? "—" : `${Math.round(util)}%`];
    if (gTemp !== null) parts.push(`${Math.round(gTemp)}°C`);
    if (gMemUsed !== null && gMemTotal) parts.push(`${fmtBytes(gMemUsed)}/${fmtBytes(gMemTotal)}`);
    rows.push({
      key: `gpu-${i}`,
      label: g?.name ? `${t("servers.gpu")} · ${g.name}` : gpus.length > 1 ? `${t("servers.gpu")} ${i + 1}` : t("servers.gpu"),
      value: util,
      tone: metricTone(util),
      text: parts.join(" · "),
    });
  });

  const batteryPct = fin(s.battery?.percent);
  if (batteryPct !== null) {
    const state = typeof s.battery?.state === "string" ? s.battery.state : null;
    rows.push({
      key: "battery",
      label: t("servers.battery"),
      value: batteryPct,
      tone: batteryTone(batteryPct, state),
      text: `${Math.round(batteryPct)}%${state ? ` · ${state}` : ""}`,
    });
  }
  return rows;
}

/** Load average (1/5/15 min) as "0.52 · 0.40 · 0.31". Load is unbounded (not a 0..100 fill), so it is shown as a
 *  text stat rather than a bar. null when the host reported none of the three (older agent / unsupported OS);
 *  a single missing window renders "—". Exported for testing. */
export function buildLoadText(s: MetricsSample): string | null {
  const vals = [fin(s.load1), fin(s.load5), fin(s.load15)];
  if (vals.every((v) => v === null)) return null;
  return vals.map((v) => (v === null ? "—" : v.toFixed(2))).join(" · ");
}

/**
 * Live gauges for the server Overview: CPU, memory and disk as progress bars — plus temperature, GPU
 * and battery when the host exposes them. Reads the same ["metrics", id] live cache the monitoring tab
 * fills, so the SSE stream keeps it ticking with no extra fetch. A sample older than the live window
 * greys out (stale) so a frozen reading never looks live; with no sample yet the card is hidden.
 */
export function LiveGauges({ id, nowMs, canWrite = false, onOpenMaintenance }: { id: string; nowMs: number; canWrite?: boolean; onOpenMaintenance?: () => void }) {
  const t = useT();
  const { data: samples = [] } = useQuery({
    queryKey: ["metrics", id],
    queryFn: () => api.getMetrics(id, 60),
    refetchInterval: 30000,
  });
  const s = samples.length ? samples[samples.length - 1] : undefined;
  if (!s) return null;
  const ts = fin(s.ts);
  const stale = ts === null || nowMs - ts > FLEET_STALE_MS;
  const gauges = buildGauges(s, t);
  const loadText = buildLoadText(s);
  // Surface disk pressure explicitly (not colour-only): warn/crit → a strip under the gauges with a CTA into
  // the Maintenance tab where cleanup lives. Uses the disk gauge's own tone (metricTone: warn>=80, crit>=90).
  const disk = gauges.find((g) => g.key === "disk");
  const diskAlert = !stale && disk && (disk.tone === "warn" || disk.tone === "crit") ? disk.tone : null;

  return (
    <Card style={{ padding: 16, marginBottom: 20 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 12 }}>
        <div style={{ fontWeight: 600 }}>{t("servers.liveTitle")}</div>
        {stale && <span style={{ fontSize: 11, color: "var(--c-tx3)" }}>{t("servers.liveStale")}</span>}
      </div>
      <div style={{ display: "grid", gap: "14px 28px", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
        {gauges.map((g) => (
          <div key={g.key} style={{ minWidth: 0 }}>
            <div style={{ fontSize: 11, color: "var(--c-tx3)", marginBottom: 6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.label}</div>
            <MeterBar grow value={g.value} tone={g.tone} text={g.text} stale={stale} label={g.label} showToneIcon />
          </div>
        ))}
        {loadText && (
          <div style={{ minWidth: 0 }} title={t("servers.loadAvgHint")}>
            <div style={{ fontSize: 11, color: "var(--c-tx3)", marginBottom: 6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t("servers.loadAvg")}</div>
            <div className="mono" aria-label={`${t("servers.loadAvg")}: ${t("servers.loadAvgHint")}`} style={{ fontSize: 13, color: stale ? "var(--c-tx3)" : "var(--c-tx)" }}>{loadText}</div>
          </div>
        )}
      </div>
      {diskAlert && (
        <div
          role={diskAlert === "crit" ? "alert" : "status"}
          style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 14, padding: "8px 12px", borderRadius: "var(--r1)", background: "var(--c-el)", border: `1px solid ${diskAlert === "crit" ? "var(--c-r)" : "var(--c-am)"}` }}
        >
          <TriangleAlert size={15} color={diskAlert === "crit" ? "var(--c-r)" : "var(--c-am)"} aria-hidden style={{ flexShrink: 0 }} />
          <span style={{ fontSize: 12.5, color: "var(--c-tx)", flex: 1, minWidth: 180 }}>{t(diskAlert === "crit" ? "servers.diskCrit" : "servers.diskWarn")}</span>
          {canWrite && onOpenMaintenance && <Btn variant="ghost" onClick={onOpenMaintenance}>{t("servers.diskCleanCta")}</Btn>}
        </div>
      )}
    </Card>
  );
}
