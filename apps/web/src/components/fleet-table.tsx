"use client";

import Link from "next/link";
import { memo, type ReactNode, type CSSProperties } from "react";
import { fmtBytes, formatUptime } from "../lib/fleet";
import { metricTone, type FleetRow, type FleetSortKey, type SortDir } from "../lib/fleet-view";
import { useT } from "../i18n/provider";
import { Card, EmptyState, StatusDot } from "./ui";

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
  return (
    <Card style={{ padding: 0 }}>
      <div role="region" aria-label={t("fleet.title")} tabIndex={0} style={{ overflowX: "auto" }}>
        <table className="fleet-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
          <caption className="sr-only">{t("fleet.title")}</caption>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--c-tx3)", borderBottom: "1px solid var(--c-bd)" }}>
              <SortTh k="name" label={t("fleet.colServer")} {...sortProps} />
              <SortTh k="cpu" label={t("fleet.colCpu")} num {...sortProps} />
              <SortTh k="mem" label={t("fleet.colMem")} num {...sortProps} />
              <SortTh k="disk" label={t("fleet.colDisk")} num {...sortProps} />
              <SortTh k="net" label={t("fleet.colNet")} num {...sortProps} />
              <SortTh k="uptime" label={t("fleet.colUptime")} num {...sortProps} />
              <Th>{t("fleet.colAgent")}</Th>
              <Th>{t("fleet.colCluster")}</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const cid = r.server.clusterId;
              const cluster: Cluster = cid ? { id: cid, name: clusterName?.(cid) ?? t("fleet.clustered") } : null;
              return <FleetRowView key={r.server.id} row={r} cluster={cluster} staleLabel={t("fleet.stale")} />;
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

const FleetRowView = memo(
  function FleetRowView({ row, cluster, staleLabel }: { row: FleetRow; cluster: Cluster; staleLabel: string }) {
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
        <PctTd value={row.cpu} stale={row.stale} />
        <PctTd value={row.memPct} stale={row.stale} />
        <PctTd value={row.diskPct} stale={row.stale} />
        <Td num className="mono" style={{ color: row.stale ? "var(--c-tx3)" : "var(--c-tx2)" }}>
          {row.net === null ? "—" : `${fmtBytes(row.net)}/s`}
        </Td>
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
    a.row.server === b.row.server, // ServerView is replaced wholesale on a refetch; ref-equal when unchanged
);

function SortTh({ k, label, num, sortKey, sortDir, onSort }: {
  k: FleetSortKey; label: string; num?: boolean; sortKey: FleetSortKey; sortDir: SortDir; onSort: (key: FleetSortKey) => void;
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
          all: "unset", cursor: "pointer", display: "inline-flex", gap: 4, alignItems: "center",
          padding: "10px 14px", width: "100%", boxSizing: "border-box", justifyContent: num ? "flex-end" : "flex-start",
          fontWeight: 500, color: active ? "var(--c-tx)" : "var(--c-tx3)", fontSize: 11.5,
        }}
      >
        {label}
        <span aria-hidden="true" style={{ opacity: active ? 1 : 0.25, fontSize: 9 }}>{active && sortDir === "asc" ? "▲" : "▼"}</span>
      </button>
    </th>
  );
}

function PctTd({ value, stale }: { value: number | null; stale: boolean }) {
  const color = value === null ? "var(--c-tx3)" : stale ? "var(--c-tx3)" : TONE_COLOR[metricTone(value)];
  return (
    <Td num>
      <span className="mono" style={{ fontWeight: 600, color }}>{value === null ? "—" : `${value.toFixed(0)}%`}</span>
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
