"use client";

import type { ReactNode, CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { fmtBytes } from "../lib/fleet";
import type { ContainerInventoryRow } from "../lib/types";
import { useT } from "../i18n/provider";
import { Card, EmptyState, Spinner, Badge } from "./ui";

/** Live inventory of every container on a server (Tugra + others) with its latest CPU/RAM/Net/Disk.
 *  Read-level — visible to any team member. Polls (no SSE for container stats). */
export function ServerContainersCard({ id }: { id: string }) {
  const t = useT();
  const { data, isLoading } = useQuery({
    queryKey: ["serverContainers", id],
    queryFn: () => api.getServerContainers(id),
    refetchInterval: 5000,
  });
  const rows = data?.containers ?? [];

  if (isLoading && rows.length === 0) {
    return <Card style={{ padding: 16, display: "flex", justifyContent: "center" }}><Spinner /></Card>;
  }
  // Gate the empty state on data ABSENCE only — a failed BACKGROUND poll keeps the last-good rows in
  // `data`, so keying on isError here would flash "no containers" over a populated table on any blip.
  if (rows.length === 0) {
    return <Card style={{ padding: 16 }}><EmptyState>{t("servers.noContainers")}</EmptyState></Card>;
  }

  return (
    <Card style={{ padding: 0, overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr style={{ textAlign: "left", color: "var(--c-tx3)", borderBottom: "1px solid var(--c-bd)" }}>
            <Th>{t("servers.containerName")}</Th>
            <Th>{t("servers.cpu")}</Th>
            <Th>{t("servers.ram")}</Th>
            <Th>{t("servers.net")}</Th>
            <Th>{t("servers.disk")}</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <ContainerRow key={r.name} row={r} />
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function ContainerRow({ row }: { row: ContainerInventoryRow }) {
  const isTugra = row.name.startsWith("tugra_");
  return (
    <tr style={{ borderBottom: "1px solid var(--c-bd)" }}>
      <Td>
        <span className="mono" style={{ wordBreak: "break-all" }}>{row.name}</span>
        {isTugra && <span style={{ marginLeft: 6 }}><Badge tone="muted">tugra</Badge></span>}
      </Td>
      <Td><Stat value={row.cpu} unit="%" warn={row.cpu >= 80} /></Td>
      <Td>
        <Stat value={row.memPct} unit="%" warn={row.memPct >= 85} />
        <span style={{ color: "var(--c-tx3)", marginLeft: 6 }}>{fmtBytes(row.memUsed)} / {fmtBytes(row.memTotal)}</span>
      </Td>
      <Td className="mono" style={{ color: "var(--c-tx2)" }}>↓{fmtBytes(row.netRx)}/s ↑{fmtBytes(row.netTx)}/s</Td>
      <Td className="mono" style={{ color: "var(--c-tx2)" }}>r{fmtBytes(row.blkRead)}/s w{fmtBytes(row.blkWrite)}/s</Td>
    </tr>
  );
}

function Stat({ value, unit, warn }: { value: number; unit: string; warn?: boolean }) {
  return (
    <span className="mono" style={{ fontWeight: 600, color: warn ? "var(--c-am)" : "var(--c-tx)" }}>
      {value.toFixed(1)}
      {unit}
    </span>
  );
}

function Th({ children }: { children: ReactNode }) {
  return <th style={{ padding: "10px 14px", fontWeight: 500, whiteSpace: "nowrap" }}>{children}</th>;
}
function Td({ children, className, style }: { children: ReactNode; className?: string; style?: CSSProperties }) {
  return <td className={className} style={{ padding: "10px 14px", whiteSpace: "nowrap", ...style }}>{children}</td>;
}
