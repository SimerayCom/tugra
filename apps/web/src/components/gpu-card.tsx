"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { relativeTime } from "../lib/fleet";
import type { GpuDevice, GpuReport } from "../lib/types";
import { useT } from "../i18n/provider";
import { CopyBtn } from "./copy-row";
import { Badge, Btn, SectionCard } from "./ui";

/** Shared with the app Resources card so both read one cached snapshot per server. */
export const gpusQueryKey = (serverId: string) => ["server-gpus", serverId] as const;

/** GB with at most one decimal (24564 MB → "24", 8192 → "8"). */
export function gpuMemoryGb(mb: number): string {
  return String(Math.round((mb / 1024) * 10) / 10);
}

/** Map a failed detect call to its i18n key suffix (403 = capability/permission, 503 = agent unreachable). */
export function gpuErrorKey(e: unknown): "errForbidden" | "errUnavailable" | "errGeneric" {
  if (e instanceof ApiError) {
    if (e.status === 403) return "errForbidden";
    if (e.status === 503) return "errUnavailable";
  }
  return "errGeneric";
}

const rowStyle: CSSProperties = { display: "flex", alignItems: "center", gap: "4px 12px", flexWrap: "wrap", padding: "6px 0", borderTop: "1px solid var(--c-bd)", fontSize: 13 };
const noteStyle = (color: string): CSSProperties => ({ margin: "8px 0 0", fontSize: 12.5, color });

function GpuRow({ g, moduleVersion }: { g: GpuDevice; moduleVersion: string | null }) {
  const t = useT();
  const driver = g.driver ?? (g.vendor === "nvidia" ? moduleVersion : null);
  return (
    <div style={rowStyle}>
      <span className="mono" style={{ fontSize: 12, color: "var(--c-tx3)", minWidth: 64 }}>
        {g.index != null ? t("servers.gpus.gpuLabel", { index: g.index }) : (g.pci ?? "—")}
      </span>
      {/* Text-only: the name is hub-sanitized AND rendered as a React text node (never as HTML). */}
      <span style={{ fontWeight: 600, minWidth: 0, overflowWrap: "anywhere" }}>{g.name}</span>
      {g.memoryMb != null && <span style={{ color: "var(--c-tx3)" }}>{t("servers.gpus.memory", { gb: gpuMemoryGb(g.memoryMb) })}</span>}
      {driver && <span style={{ color: "var(--c-tx3)" }}>{t("servers.gpus.driver", { v: driver })}</span>}
      {g.uuid && (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <code className="mono" style={{ fontSize: 11, color: "var(--c-tx3)" }} title={g.uuid}>{`${g.uuid.slice(0, 12)}…${g.uuid.slice(-4)}`}</code>
          <CopyBtn text={`device=${g.uuid}`} label={t("servers.gpus.copyFlag")} />
        </span>
      )}
    </div>
  );
}

/** Servers whose automatic refresh was refused with a 403 (a revoked capability grant the hub-sent `canOps` cannot see):
 *  later visits skip the automatic attempt instead of re-failing on every page load. Explicit clicks always go through. */
const autoForbidden = new Set<string>();

/**
 * "Detected GPUs" — the persisted GPU/Docker-runtime snapshot of one server. A viewer holding the permission the
 * refresh endpoint requires (`canOps` = servers:ops) refreshes an unknown or stale snapshot once; everyone else only
 * ever sees the last result. Unknown is "not checked", never "no GPU".
 */
export function GpuCard({ serverId, canOps, online }: { serverId: string; canOps: boolean; online: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: gpusQueryKey(serverId), queryFn: () => api.getServerGpus(serverId), staleTime: 30_000, retry: false });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [, setTick] = useState(0);

  // `auto` = the visit-triggered refresh: a 403 there is silent (and stops further automatic attempts); a click always reports.
  const refresh = useMutation({
    mutationFn: (_auto: boolean) => api.refreshServerGpus(serverId),
    onSuccess: (r: GpuReport) => {
      setError(null);
      setBusy(!!r.busy);
      qc.setQueryData(gpusQueryKey(serverId), r);
    },
    onError: (e: unknown, auto: boolean) => {
      if (auto && gpuErrorKey(e) === "errForbidden") {
        autoForbidden.add(serverId);
        return;
      }
      setError(t(`servers.gpus.${gpuErrorKey(e)}`));
    },
  });

  // Re-render every 15 s so "checked N ago" keeps moving.
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 15_000);
    return () => clearInterval(id);
  }, []);

  const report = q.data;
  const auto = useRef(false);
  useEffect(() => {
    if (auto.current || !report || !canOps || !online || autoForbidden.has(serverId)) return;
    if (report.readiness === "unknown" || report.stale) {
      auto.current = true;
      refresh.mutate(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report, canOps, online]);

  const disabledReason = !canOps ? t("servers.gpus.refreshNeedsWrite") : !online ? t("servers.gpus.refreshOffline") : undefined;
  const inv = report?.inventory ?? null;
  const real = (inv?.gpus ?? []).filter((g) => g.kind === "gpu");
  const virtual = (inv?.gpus ?? []).filter((g) => g.kind === "virtual");
  const rd = report?.readiness;

  const right = (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
      {report?.checkedAt && <span style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("servers.gpus.checkedAgo", { ago: relativeTime(report.checkedAt) })}</span>}
      {report?.stale && <Badge tone="warn">{t("servers.gpus.stale")}</Badge>}
      <Btn variant="ghost" disabled={!canOps || !online || refresh.isPending} title={disabledReason} onClick={() => refresh.mutate(false)}>
        {refresh.isPending ? t("servers.gpus.refreshing") : t("servers.gpus.refresh")}
      </Btn>
    </span>
  );

  return (
    <SectionCard title={t("servers.gpus.title")} right={right} style={{ marginTop: 16 }}>
      {q.isLoading && <p style={noteStyle("var(--c-tx3)")}>{t("servers.gpus.refreshing")}</p>}
      {q.isError && <p role="alert" style={noteStyle("var(--c-am)")}>{t("servers.gpus.errGeneric")}</p>}
      {report && rd === "unknown" && <p style={{ ...noteStyle("var(--c-tx3)"), marginTop: 0 }}>{online ? t("servers.gpus.neverChecked") : t("servers.gpus.serverOffline")}</p>}
      {report && rd === "none" && <p style={{ ...noteStyle("var(--c-tx3)"), marginTop: 0 }}>{t("servers.gpus.none")}</p>}
      {rd === "ready" && <p style={{ ...noteStyle("var(--c-g)"), marginTop: 0, fontWeight: 600 }}>{t("servers.gpus.ready")}</p>}
      {rd && rd !== "unknown" && rd !== "none" && rd !== "ready" && (
        <p role="note" style={{ ...noteStyle(rd === "non_nvidia" ? "var(--c-tx3)" : "var(--c-am)"), marginTop: 0 }}>
          {rd === "driver_missing" ? t("servers.gpus.driverMissing") : rd === "runtime_missing" ? t("servers.gpus.runtimeMissing") : rd === "non_nvidia" ? t("servers.gpus.nonNvidia") : t("servers.gpus.probeFailed")}
        </p>
      )}
      {rd === "probe_failed" && inv?.error && <p className="mono" style={{ ...noteStyle("var(--c-tx3)"), overflowWrap: "anywhere" }}>{t("servers.gpus.probeFailedDetail", { error: inv.error })}</p>}
      {real.length > 0 && (
        <div style={{ marginTop: 8 }}>
          {real.map((g, i) => <GpuRow key={`${g.pci ?? ""}-${g.index ?? i}`} g={g} moduleVersion={inv?.nvidiaModuleVersion ?? null} />)}
        </div>
      )}
      {virtual.length > 0 && (
        <details style={{ marginTop: 8 }}>
          <summary style={{ cursor: "pointer", fontSize: 12.5, color: "var(--c-tx3)" }}>{t("servers.gpus.virtualDisplays", { n: virtual.length })}</summary>
          {virtual.map((g, i) => <GpuRow key={`v-${g.pci ?? i}`} g={g} moduleVersion={null} />)}
        </details>
      )}
      {busy && <p style={noteStyle("var(--c-tx3)")}>{t("servers.gpus.busy")}</p>}
      {error && <p role="alert" style={noteStyle("var(--c-r)")}>{error}</p>}
    </SectionCard>
  );
}
