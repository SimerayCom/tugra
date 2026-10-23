"use client";

import Link from "next/link";
import { memo, type ReactNode, type CSSProperties } from "react";
import { fmtBytes, formatUptime } from "../lib/fleet";
import { metricTone, tempTone, batteryTone, type FleetRow, type FleetSortKey, type SortDir, type MetricTone } from "../lib/fleet-view";
import { useT } from "../i18n/provider";
import { Card, EmptyState, StatusDot } from "./ui";
import { MeterBar } from "./meter-bar";
import { Server, Cpu, MemoryStick, HardDrive, ArrowDownUp, Thermometer, Gpu, BatteryMedium, Clock, type LucideIcon } from "lucide-react";

const TONE_COLOR: Record<string, string> = { ok: "var(--c-tx)", warn: "var(--c-am)", crit: "var(--c-r)" };
const enc = encodeURIComponent;

type Cluster = { id: string; name: string } | null;

/** Dense all-servers live table: one row per server, sortable, with threshold colouring and
 *  stale-greying. The server name is a stretched link covering the row (keyboard + mouse); the
 *  cluster chip opens the cluster. */
export function FleetTable({
  rows,
  sortKey,
  sortDir,
  onSort,
  clusterName,
}: {
  rows: FleetRow[];
  sortKey: FleetSortKey;
  sortDir: SortDir;
  onSort: (key: FleetSortKey) => void;
  clusterName?: (id: string) => string | null;
}) {
  const t = useT();

  if (rows.length === 0) {
    return (
      <Card style={{ padding: 24 }}>
        <div role="status">
          <EmptyState>{t("fleet.noMatch")}</EmptyState>
        </div>
      </Card>
    );
  }

  const sortProps = { sortKey, sortDir, onSort };
  const clusterFor = (r: FleetRow): Cluster => {
    const cid = r.server.clusterId;
    return cid ? { id: cid, name: clusterName?.(cid) ?? t("fleet.clustered") } : null;
  };
  const staleLabel = t("fleet.stale");
  // Desktop: dense table. Mobile (<768px): the same rows as cards. Both render; CSS shows one.
  return (
    <>
      <div className="fleet-table-card">
        <Card style={{ padding: 0 }}>
          <div role="region" aria-label={t("fleet.title")} tabIndex={0} style={{ overflowX: "auto" }}>
            <table className="fleet-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
              <caption className="sr-only">{t("fleet.title")}</caption>
              <thead>
                <tr style={{ textAlign: "left", color: "var(--c-tx3)", borderBottom: "1px solid var(--c-bd)" }}>
                  <SortTh k="name" label={t("fleet.colServer")} icon={Server} {...sortProps} />
                  <SortTh k="cpu" label={t("fleet.colCpu")} icon={Cpu} num {...sortProps} />
                  <SortTh k="mem" label={t("fleet.colMem")} icon={MemoryStick} num {...sortProps} />
                  <SortTh k="disk" label={t("fleet.colDisk")} icon={HardDrive} num {...sortProps} />
                  <SortTh k="net" label={t("fleet.colNet")} icon={ArrowDownUp} num {...sortProps} />
                  <SortTh k="temp" label={t("fleet.colTemp")} icon={Thermometer} num {...sortProps} />
                  <SortTh k="gpu" label={t("fleet.colGpu")} icon={Gpu} num {...sortProps} />
                  <SortTh k="battery" label={t("fleet.colBattery")} icon={BatteryMedium} num {...sortProps} />
                  <SortTh k="uptime" label={t("fleet.colUptime")} icon={Clock} num {...sortProps} />
                  <Th>{t("fleet.colAgent")}</Th>
                  <Th>{t("fleet.colCluster")}</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <FleetRowView key={r.server.id} row={r} cluster={clusterFor(r)} staleLabel={staleLabel} />
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
      <ul className="fleet-cards" aria-label={t("fleet.title")}>
        {rows.map((r) => (
          <FleetCardView key={r.server.id} row={r} cluster={clusterFor(r)} staleLabel={staleLabel} />
        ))}
      </ul>
    </>
  );
}

const pctColor = (value: number | null, stale: boolean) =>
  value === null || stale ? "var(--c-tx3)" : TONE_COLOR[metricTone(value)];

const FleetRowView = memo(
  function FleetRowView({ row, cluster, staleLabel }: { row: FleetRow; cluster: Cluster; staleLabel: string }) {
    const t = useT();
    const s = row.server;
    return (
      <tr className="fleet-row" style={{ borderBottom: "1px solid var(--c-bd)", position: "relative" }}>
        <Td>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <StatusDot status={s.status} />
            <div style={{ minWidth: 0 }}>
              <Link href={`/servers/${enc(s.id)}`} className="fleet-namelink" style={{ color: "var(--c-tx)", textDecoration: "none", fontWeight: 500 }}>
                {s.name}
                {row.stale && <span className="sr-only"> — {staleLabel}</span>}
              </Link>
              <div className="mono" style={{ fontSize: 10.5, color: "var(--c-tx3)" }}>{s.hostname ?? s.publicIp ?? "—"}</div>
            </div>
          </div>
        </Td>
        <MeterTd value={row.cpu} tone={metricTone(row.cpu)} text={pctText(row.cpu)} stale={row.stale} label={t("fleet.colCpu")} />
        <MeterTd value={row.memPct} tone={metricTone(row.memPct)} text={pctText(row.memPct)} stale={row.stale} label={t("fleet.colMem")} />
        <MeterTd value={row.diskPct} tone={metricTone(row.diskPct)} text={pctText(row.diskPct)} stale={row.stale} label={t("fleet.colDisk")} />
        <Td num className="mono" style={{ color: row.stale ? "var(--c-tx3)" : "var(--c-tx2)" }}>
          {row.net === null ? "—" : `${fmtBytes(row.net)}/s`}
        </Td>
        <MeterTd value={row.temp} tone={tempTone(row.temp)} text={row.temp === null ? "—" : `${row.temp.toFixed(0)}°C`} stale={row.stale} label={t("fleet.colTemp")} />
        <MeterTd value={row.gpuUtil} tone={metricTone(row.gpuUtil)} text={pctText(row.gpuUtil)} stale={row.stale} label={t("fleet.colGpu")} />
        <MeterTd value={row.battery} tone={batteryTone(row.battery, row.batteryState)} text={row.battery === null ? "—" : `${row.battery.toFixed(0)}%`} stale={row.stale} label={t("fleet.colBattery")} />
        <Td num className="mono" style={{ color: "var(--c-tx2)" }}>{formatUptime(s.uptimeSeconds)}</Td>
        <Td className="mono" style={{ color: "var(--c-tx3)" }}>{s.agentVersion ?? "—"}</Td>
        <Td>
          {cluster ? (
            <Link href={`/clusters/${enc(cluster.id)}`} className="fleet-clusterlink" style={{ color: "var(--c-lapis)", textDecoration: "none", fontSize: 11.5 }}>
              {cluster.name}
            </Link>
          ) : (
            <span style={{ color: "var(--c-tx3)" }}>—</span>
          )}
        </Td>
      </tr>
    );
  },
  (a, b) =>
    a.staleLabel === b.staleLabel &&
    a.cluster?.id === b.cluster?.id &&
    a.cluster?.name === b.cluster?.name &&
    a.row.stale === b.row.stale &&
    a.row.cpu === b.row.cpu &&
    a.row.memPct === b.row.memPct &&
    a.row.diskPct === b.row.diskPct &&
    a.row.net === b.row.net &&
    a.row.temp === b.row.temp &&
    a.row.gpuUtil === b.row.gpuUtil &&
    a.row.gpuTemp === b.row.gpuTemp &&
    a.row.battery === b.row.battery &&
    a.row.batteryState === b.row.batteryState &&
    a.row.server === b.row.server, // ServerView is replaced wholesale on a refetch; ref-equal when unchanged
);

const FleetCardView = memo(
  function FleetCardView({ row, cluster, staleLabel }: { row: FleetRow; cluster: Cluster; staleLabel: string }) {
    const t = useT();
    const s = row.server;
    return (
      <li className="fleet-card" style={{ listStyle: "none", position: "relative", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <StatusDot status={s.status} />
          <Link href={`/servers/${enc(s.id)}`} className="fleet-namelink" style={{ color: "var(--c-tx)", textDecoration: "none", fontWeight: 600, fontSize: 14, minWidth: 0 }}>
            {s.name}
            {row.stale && <span className="sr-only"> — {staleLabel}</span>}
          </Link>
          {cluster && (
            <Link href={`/clusters/${enc(cluster.id)}`} className="fleet-clusterlink" style={{ marginLeft: "auto", color: "var(--c-lapis)", textDecoration: "none", fontSize: 11 }}>
              {cluster.name}
            </Link>
          )}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
          <Gauge label={t("fleet.colCpu")} value={row.cpu} stale={row.stale} />
          <Gauge label={t("fleet.colMem")} value={row.memPct} stale={row.stale} />
          <Gauge label={t("fleet.colDisk")} value={row.diskPct} stale={row.stale} />
        </div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 10, fontSize: 11, color: "var(--c-tx3)" }}>
          <span>{t("fleet.colNet")} <b style={{ color: "var(--c-tx2)", fontWeight: 500 }}>{row.net === null ? "—" : `${fmtBytes(row.net)}/s`}</b></span>
          {row.temp !== null && <span>{t("fleet.colTemp")} <b style={{ color: "var(--c-tx2)", fontWeight: 500 }}>{`${row.temp.toFixed(0)}°C`}</b></span>}
          {row.gpuUtil !== null && <span>{t("fleet.colGpu")} <b style={{ color: "var(--c-tx2)", fontWeight: 500 }}>{`${row.gpuUtil.toFixed(0)}%`}</b></span>}
          {row.battery !== null && <span>{t("fleet.colBattery")} <b style={{ color: "var(--c-tx2)", fontWeight: 500 }}>{`${row.battery.toFixed(0)}%`}</b></span>}
          <span>{t("fleet.colUptime")} <b style={{ color: "var(--c-tx2)", fontWeight: 500 }}>{formatUptime(s.uptimeSeconds)}</b></span>
          <span>{t("fleet.colAgent")} <b style={{ color: "var(--c-tx2)", fontWeight: 500 }}>{s.agentVersion ?? "—"}</b></span>
        </div>
      </li>
    );
  },
  (a, b) =>
    a.staleLabel === b.staleLabel &&
    a.cluster?.id === b.cluster?.id &&
    a.cluster?.name === b.cluster?.name &&
    a.row.stale === b.row.stale &&
    a.row.cpu === b.row.cpu &&
    a.row.memPct === b.row.memPct &&
    a.row.diskPct === b.row.diskPct &&
    a.row.net === b.row.net &&
    a.row.temp === b.row.temp &&
    a.row.gpuUtil === b.row.gpuUtil &&
    a.row.gpuTemp === b.row.gpuTemp &&
    a.row.battery === b.row.battery &&
    a.row.batteryState === b.row.batteryState &&
    a.row.server === b.row.server,
);

function Gauge({ label, value, stale }: { label: string; value: number | null; stale: boolean }) {
  return (
    <div style={{ background: "var(--c-el)", borderRadius: "var(--r1)", padding: "8px 6px", textAlign: "center" }}>
      <div style={{ fontSize: 9.5, color: "var(--c-tx3)", textTransform: "uppercase", letterSpacing: ".05em" }}>{label}</div>
      <div className="mono" style={{ fontSize: 16, fontWeight: 700, color: pctColor(value, stale) }}>{value === null ? "—" : `${value.toFixed(0)}%`}</div>
    </div>
  );
}

function SortTh({ k, label, num, icon: Icon, sortKey, sortDir, onSort }: {
  k: FleetSortKey; label: string; num?: boolean; icon?: LucideIcon; sortKey: FleetSortKey; sortDir: SortDir; onSort: (key: FleetSortKey) => void;
}) {
  const active = sortKey === k;
  return (
    <th
      // aria-sort belongs on the column header, not the button, so screen readers announce the sort.
      aria-sort={active ? (sortDir === "asc" ? "ascending" : "descending") : undefined}
      style={{ padding: 0, whiteSpace: "nowrap", textAlign: num ? "right" : "left" }}
    >
      <button
        type="button"
        className="fleet-sort"
        onClick={() => onSort(k)}
        style={{
          all: "unset", cursor: "pointer", display: "inline-flex", gap: 5, alignItems: "center",
          padding: "10px 14px", width: "100%", boxSizing: "border-box", justifyContent: num ? "flex-end" : "flex-start",
          fontWeight: 500, color: active ? "var(--c-tx)" : "var(--c-tx3)", fontSize: 11.5,
        }}
      >
        {Icon && <Icon size={13} aria-hidden strokeWidth={2} style={{ flexShrink: 0, opacity: active ? 0.9 : 0.5 }} />}
        {label}
        <span aria-hidden="true" style={{ opacity: active ? 1 : 0.25, fontSize: 9 }}>{active && sortDir === "asc" ? "▲" : "▼"}</span>
      </button>
    </th>
  );
}

const pctText = (v: number | null) => (v === null ? "—" : `${v.toFixed(0)}%`);

/** A right-aligned table cell holding a MeterBar (bar + value). Replaces the old text-only PctTd. */
function MeterTd({ value, tone, text, stale, label }: { value: number | null; tone: MetricTone; text: string; stale: boolean; label: string }) {
  return (
    <Td num>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <MeterBar value={value} tone={tone} text={text} stale={stale} label={label} />
      </div>
    </Td>
  );
}

function Th({ children }: { children: ReactNode }) {
  return <th style={{ padding: "10px 14px", fontWeight: 500, whiteSpace: "nowrap", fontSize: 11.5 }}>{children}</th>;
}
function Td({ children, num, className, style }: { children: ReactNode; num?: boolean; className?: string; style?: CSSProperties }) {
  return (
    <td className={className} style={{ padding: "9px 14px", whiteSpace: "nowrap", textAlign: num ? "right" : "left", fontVariantNumeric: "tabular-nums", ...style }}>
      {children}
    </td>
  );
}
