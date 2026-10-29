"use client";

import { useState, type ReactNode, type CSSProperties } from "react";
import Link from "next/link";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { fmtBytes } from "../lib/fleet";
import { metricTone } from "../lib/fleet-view";
import type { ContainerInventoryRow } from "../lib/types";
import { useT } from "../i18n/provider";
import { Card, EmptyState, Spinner, Badge, Btn } from "./ui";
import { MeterBar } from "./meter-bar";
import { Server, Cpu, MemoryStick, HardDrive, ArrowDownUp, RotateCw, Square, ScrollText, Trash2, type LucideIcon } from "lucide-react";
import { Modal } from "./modal";
import { LiveLogsCard } from "./live-logs-card";
import { useToast } from "./toast";

/** Live inventory of every container on a server (Tugra + others) with its latest CPU/RAM/Net/Disk.
 *  Read-level stats; writers can also open any container's live logs from here. Polls (no SSE for stats). */
export function ServerContainersCard({ id, canWrite = false }: { id: string; canWrite?: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const [logsFor, setLogsFor] = useState<string | null>(null);
  const [removeFor, setRemoveFor] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const { data, isLoading } = useQuery({
    queryKey: ["serverContainers", id],
    queryFn: () => api.getServerContainers(id),
    refetchInterval: 5000,
  });
  const act = useMutation({
    mutationFn: (v: { container: string; action: "restart" | "stop" | "remove"; confirmName?: string }) =>
      api.containerAction(id, v.container, v.action, v.confirmName),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["serverContainers", id] }),
    onError: (e) => toast((e as Error).message, "error"),
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
    <>
      <Card style={{ padding: 0, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--c-tx3)", borderBottom: "1px solid var(--c-bd)" }}>
              <Th icon={Server}>{t("servers.containerName")}</Th>
              <Th icon={Cpu}>{t("servers.cpu")}</Th>
              <Th icon={MemoryStick}>{t("servers.ram")}</Th>
              <Th icon={ArrowDownUp}>{t("servers.net")}</Th>
              <Th icon={HardDrive}>{t("servers.disk")}</Th>
              {canWrite && <Th>{""}</Th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <ContainerRow
                key={r.name}
                row={r}
                canWrite={canWrite}
                busy={act.isPending}
                onLogs={() => setLogsFor(r.name)}
                onAction={(action) => act.mutate({ container: r.name, action })}
                onRemove={() => { setRemoveFor(r.name); setConfirmText(""); }}
              />
            ))}
          </tbody>
        </table>
      </Card>

      {logsFor && (
        <Modal
          onClose={() => setLogsFor(null)}
          zIndex={9000}
          backdropStyle={{ background: "rgba(0,0,0,0.55)", backdropFilter: "blur(3px)", alignItems: "flex-start", paddingTop: "6vh" }}
          cardStyle={{ width: 820, maxWidth: "94vw", background: "var(--c-sb)", padding: 16 }}
        >
          <LiveLogsCard basePath={`/servers/${id}/containers`} container={logsFor} title={logsFor} />
        </Modal>
      )}

      {removeFor && (
        <Modal
          onClose={() => { setRemoveFor(null); setConfirmText(""); }}
          zIndex={9000}
          backdropStyle={{ background: "rgba(0,0,0,0.55)", backdropFilter: "blur(3px)", alignItems: "flex-start", paddingTop: "12vh" }}
          cardStyle={{ width: 460, maxWidth: "92vw", background: "var(--c-sb)", padding: 20 }}
        >
          <h2 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 10px" }}>{t("servers.containerRemoveTitle")}</h2>
          <p style={{ fontSize: 13, color: "var(--c-tx2)", margin: "0 0 14px" }}>{t("servers.containerRemoveBody", { name: removeFor })}</p>
          <input
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={removeFor}
            autoFocus
            style={{ width: "100%", padding: "8px 10px", background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", color: "var(--c-tx)", fontSize: 13, fontFamily: "var(--font-mono)" }}
          />
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
            <Btn variant="ghost" onClick={() => { setRemoveFor(null); setConfirmText(""); }}>{t("servers.cancel")}</Btn>
            <Btn
              variant="danger"
              disabled={confirmText !== removeFor || act.isPending}
              onClick={() => act.mutate(
                { container: removeFor, action: "remove", confirmName: removeFor },
                { onSuccess: () => { setRemoveFor(null); setConfirmText(""); } },
              )}
            >
              {t("servers.containerRemove")}
            </Btn>
          </div>
        </Modal>
      )}
    </>
  );
}

function ContainerRow({ row, canWrite, busy, onLogs, onAction, onRemove }: {
  row: ContainerInventoryRow;
  canWrite: boolean;
  busy: boolean;
  onLogs: () => void;
  onAction: (action: "restart" | "stop") => void;
  onRemove: () => void;
}) {
  const t = useT();
  const href = row.resourceId ? (row.kind === "db" ? `/databases/${row.resourceId}` : `/apps/${row.resourceId}`) : null;
  return (
    <tr style={{ borderBottom: "1px solid var(--c-bd)" }}>
      <Td>
        <div style={{ fontWeight: 500, display: "flex", alignItems: "center", gap: 6 }}>
          {href ? (
            <Link href={href} style={{ color: "var(--c-tx)", textDecoration: "none" }}>{row.label}</Link>
          ) : (
            row.label
          )}
          {row.kind === "system" && <Badge tone="muted">system</Badge>}
        </div>
        <div className="mono" style={{ fontSize: 10.5, color: "var(--c-tx3)", wordBreak: "break-all", marginTop: 2 }}>{row.name}</div>
      </Td>
      <Td><MeterBar value={row.cpu} tone={metricTone(row.cpu)} text={`${row.cpu.toFixed(0)}%`} label={t("servers.cpu")} /></Td>
      <Td>
        <MeterBar value={row.memPct} tone={metricTone(row.memPct)} text={`${row.memPct.toFixed(0)}%`} label={t("servers.ram")} />
        <span style={{ display: "block", color: "var(--c-tx3)", fontSize: 10.5, marginTop: 3 }}>{fmtBytes(row.memUsed)} / {fmtBytes(row.memTotal)}</span>
      </Td>
      <Td className="mono" style={{ color: "var(--c-tx2)" }}>↓{fmtBytes(row.netRx)}/s ↑{fmtBytes(row.netTx)}/s</Td>
      <Td className="mono" style={{ color: "var(--c-tx2)" }}>r{fmtBytes(row.blkRead)}/s w{fmtBytes(row.blkWrite)}/s</Td>
      {canWrite && (
        <Td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
          {row.kind !== "system" && (
            <>
              <Btn variant="ghost" icon={RotateCw} onClick={() => onAction("restart")} disabled={busy}>{t("servers.containerRestart")}</Btn>
              <Btn variant="ghost" icon={Square} onClick={() => onAction("stop")} disabled={busy}>{t("servers.containerStop")}</Btn>
            </>
          )}
          <Btn variant="ghost" icon={ScrollText} onClick={onLogs}>{t("servers.containerLogs")}</Btn>
          {row.kind === "other" && <Btn variant="danger" icon={Trash2} onClick={onRemove} disabled={busy}>{t("servers.containerRemove")}</Btn>}
        </Td>
      )}
    </tr>
  );
}

function Th({ children, icon: Icon }: { children: ReactNode; icon?: LucideIcon }) {
  return (
    <th style={{ padding: "10px 14px", fontWeight: 500, whiteSpace: "nowrap" }}>
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
