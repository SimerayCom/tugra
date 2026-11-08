"use client";

import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Box, Boxes, Cpu, Database, HardDrive, MemoryStick, Server, ArrowDownUp, type LucideIcon } from "lucide-react";
import { api } from "../lib/api";
import { fmtBytes } from "../lib/fleet";
import { metricTone } from "../lib/fleet-view";
import type { HottestContainerRow } from "../lib/types";
import { useT } from "../i18n/provider";
import { Btn, Card } from "./ui";
import { MeterBar } from "./meter-bar";
import { SkeletonTable } from "./skeleton";

const HOTTEST_LIMIT = 10;
const KIND_ICON: Record<HottestContainerRow["kind"], LucideIcon> = { app: Boxes, db: Database, system: Server, other: Box };

/** Fleet-wide "hottest containers": the live containers across every server the caller can see, ranked by
 *  CPU (one hub call; the hub scopes it to the caller's servers). Polls like the other fleet widgets. */
export function HottestContainersCard({ teamId }: { teamId?: string | null }) {
  const t = useT();
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["fleetHottestContainers", teamId ?? null],
    queryFn: () => api.getFleetHottestContainers(HOTTEST_LIMIT, teamId ?? undefined),
    select: (d) => (Array.isArray(d) ? d : []),
    refetchInterval: 10_000,
  });
  const rows = data ?? [];
  const title = t("dashboard.hottest");
  return (
    <section aria-labelledby="hottest-title" style={{ marginBottom: 28 }}>
      <div id="hottest-title" style={{ fontSize: 13, fontWeight: 600, color: "var(--c-tx)" }}>{title}</div>
      <div style={{ fontSize: 11, lineHeight: 1.4, color: "var(--c-tx3)", margin: "2px 0 10px" }}>{t("dashboard.hottestHint")}</div>
      {isLoading ? (
        <SkeletonTable rows={3} />
      ) : isError && data === undefined ? (
        <Card style={{ padding: 16 }}>
          <div role="alert" style={{ minHeight: 80, display: "flex", alignItems: "center", justifyContent: "center", gap: 12, flexWrap: "wrap", fontSize: 12, color: "var(--c-tx3)", textAlign: "center" }}>
            {t("dashboard.hottestError")}
            <Btn variant="ghost" onClick={() => void refetch()}>{t("errors.retry")}</Btn>
          </div>
        </Card>
      ) : rows.length === 0 ? (
        <Card style={{ padding: 16 }}>
          <div role="status" style={{ minHeight: 80, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "var(--c-tx3)", textAlign: "center" }}>
            {t("dashboard.hottestEmpty")}
          </div>
        </Card>
      ) : (
        <Card style={{ padding: 0, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <caption style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" }}>{title}</caption>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--c-tx3)", borderBottom: "1px solid var(--c-bd)" }}>
                <Th>{t("dashboard.hottestRank")}</Th>
                <Th icon={Box}>{t("servers.containerName")}</Th>
                <Th icon={Server}>{t("servers.server")}</Th>
                <Th icon={Cpu}>{t("servers.cpu")}</Th>
                <Th icon={MemoryStick}>{t("servers.ram")}</Th>
                <Th icon={ArrowDownUp}>{t("servers.net")}</Th>
                <Th icon={HardDrive}>{t("servers.disk")}</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => <HottestRow key={`${r.serverId}/${r.containerName}`} row={r} rank={i + 1} />)}
            </tbody>
          </table>
        </Card>
      )}
    </section>
  );
}

function HottestRow({ row, rank }: { row: HottestContainerRow; rank: number }) {
  const t = useT();
  const href = row.resourceId ? (row.kind === "db" ? `/databases/${row.resourceId}` : `/apps/${row.resourceId}`) : null;
  const Icon = KIND_ICON[row.kind] ?? Box;
  return (
    <tr style={{ borderBottom: "1px solid var(--c-bd)" }}>
      <th scope="row" className="mono" style={{ padding: "10px 14px", fontWeight: 500, color: "var(--c-tx3)", textAlign: "left" }}>{rank}</th>
      <Td>
        <div style={{ fontWeight: 500, display: "flex", alignItems: "center", gap: 6 }}>
          <Icon size={15} strokeWidth={2} aria-hidden style={{ flexShrink: 0, opacity: 0.65 }} />
          {href ? <Link href={href} style={{ color: "var(--c-tx)", textDecoration: "none" }}>{row.label}</Link> : row.label}
        </div>
        <div className="mono" style={{ fontSize: 10.5, color: "var(--c-tx3)", wordBreak: "break-all", marginTop: 2 }}>{row.containerName}</div>
      </Td>
      <Td><Link href={`/servers/${row.serverId}`} style={{ color: "var(--c-tx2)", textDecoration: "none" }}>{row.serverName}</Link></Td>
      <Td><MeterBar value={row.cpu} tone={metricTone(row.cpu)} text={`${row.cpu.toFixed(0)}%`} label={t("servers.cpu")} /></Td>
      <Td>
        <MeterBar value={row.memPct} tone={metricTone(row.memPct)} text={`${row.memPct.toFixed(0)}%`} label={t("servers.ram")} />
        <span style={{ display: "block", color: "var(--c-tx3)", fontSize: 10.5, marginTop: 3 }}>{fmtBytes(row.memUsed)} / {fmtBytes(row.memTotal)}</span>
      </Td>
      <Td className="mono" style={{ color: "var(--c-tx2)" }}>↓{fmtBytes(row.netRx)}/s ↑{fmtBytes(row.netTx)}/s</Td>
      <Td className="mono" style={{ color: "var(--c-tx2)" }}>r{fmtBytes(row.blkRead)}/s w{fmtBytes(row.blkWrite)}/s</Td>
    </tr>
  );
}

function Th({ children, icon: Icon }: { children: ReactNode; icon?: LucideIcon }) {
  return (
    <th scope="col" style={{ padding: "10px 14px", fontWeight: 500, whiteSpace: "nowrap" }}>
      <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
        {Icon && <Icon size={13} aria-hidden strokeWidth={2} style={{ flexShrink: 0, opacity: 0.6 }} />}
        {children}
      </span>
    </th>
  );
}
function Td({ children, className, style }: { children: ReactNode; className?: string; style?: CSSProperties }) {
  return <td className={className} style={{ padding: "10px 14px", whiteSpace: "nowrap", ...style }}>{children}</td>;
}
