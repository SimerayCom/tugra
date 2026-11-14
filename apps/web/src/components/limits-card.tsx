"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { gpusAdvice } from "../lib/gpu-advice";
import { useT } from "../i18n/provider";
import { gpusQueryKey, gpuErrorKey, gpuMemoryGb } from "./gpu-card";
import { ConfigCard, Field, NumberInput, TextInput, useSaveFeedback } from "./form";

/**
 * Optional CPU/memory limits (+ Swarm reservation hints) and the deploy timeout. Every field now
 * carries a visible label — the inputs used to be placeholder-only, so they had no accessible name
 * at all — and Save is gated until something actually changes.
 */
export function LimitsCard({ id, memoryMb, cpus, reserveMemoryMb, reserveCpus, memorySwapMb, pidsLimit, shmSizeMb, cpuShares, cpusetCpus, gpus, deployTimeoutSec, clusterId, serverId }: {
  id: string;
  memoryMb: number | null;
  cpus: number | null;
  reserveMemoryMb: number | null;
  reserveCpus: number | null;
  memorySwapMb: number | null;
  pidsLimit: number | null;
  shmSizeMb: number | null;
  cpuShares: number | null;
  cpusetCpus: string | null;
  gpus: string | null;
  deployTimeoutSec: number | null;
  clusterId: string | null;
  /** The app's server — enables the advisory "detected GPUs" hints. Optional: the card works without it. */
  serverId?: string | null;
}) {
  const t = useT();
  const qc = useQueryClient();
  const feedback = useSaveFeedback("apps.saved");
  const numStr = (n: number | null) => (n != null ? String(n) : "");
  const [mem, setMem] = useState(numStr(memoryMb));
  const [cpu, setCpu] = useState(numStr(cpus));
  const [reserveMem, setReserveMem] = useState(numStr(reserveMemoryMb));
  const [reserveCpu, setReserveCpu] = useState(numStr(reserveCpus));
  const [swap, setSwap] = useState(numStr(memorySwapMb));
  const [pids, setPids] = useState(numStr(pidsLimit));
  const [shm, setShm] = useState(numStr(shmSizeMb));
  const [shares, setShares] = useState(numStr(cpuShares));
  const [cpuset, setCpuset] = useState(cpusetCpus ?? "");
  const [gpu, setGpu] = useState(gpus ?? "");
  const [timeout, setTimeoutS] = useState(numStr(deployTimeoutSec));

  // Dirty vs the current server values, so Save enables on a real edit and settles after a save.
  const dirty =
    mem !== numStr(memoryMb) ||
    cpu !== numStr(cpus) ||
    gpu.trim() !== (gpus ?? "") ||
    timeout !== numStr(deployTimeoutSec) ||
    (!!clusterId && (reserveMem !== numStr(reserveMemoryMb) || reserveCpu !== numStr(reserveCpus))) ||
    (!clusterId && (swap !== numStr(memorySwapMb) || pids !== numStr(pidsLimit) || shm !== numStr(shmSizeMb) || shares !== numStr(cpuShares) || cpuset.trim() !== (cpusetCpus ?? "")));

  // Client-side mirrors of the hub's checks (the hub stays authoritative): swap needs a memory limit and must not
  // be below it (-1 = unlimited), and the cpuset must be indices/ranges with ordered ranges.
  const cpusetTrim = cpuset.trim();
  const cpusetOk = !cpusetTrim || (/^[0-9]+(-[0-9]+)?(,[0-9]+(-[0-9]+)?)*$/.test(cpusetTrim) && cpusetTrim.split(",").every((p) => { const [lo, hi] = p.split("-").map(Number); return hi === undefined || hi >= lo; }));
  const swapN = swap ? Number(swap) : null;
  const swapNeedsMemory = !clusterId && swapN != null && !mem;
  const swapBelowMemory = !clusterId && swapN != null && swapN > 0 && !!mem && swapN < Number(mem);
  // Hub ranges: swap is -1 or 16..1048576 MB; PIDs is -1 or 1..4194304 (0 is invalid). Integers only.
  const inRange = (raw: string, min: number, max: number) => {
    if (!raw) return true; // empty = unset
    const n = Number(raw);
    return Number.isInteger(n) && (n === -1 || (n >= min && n <= max));
  };
  const swapRangeBad = !clusterId && !inRange(swap, 16, 1024 * 1024);
  const pidsRangeBad = !clusterId && !inRange(pids, 1, 4194304);
  const invalid = !clusterId && (swapNeedsMemory || swapBelowMemory || swapRangeBad || pidsRangeBad || !cpusetOk);

  const save = useMutation({
    mutationFn: () =>
      api.setAppLimits(id, {
        memoryMb: mem ? Number(mem) : null,
        cpus: cpu ? Number(cpu) : null,
        // Swarm-only reservation hints; only sent for a clustered app (fields are hidden otherwise).
        reserveMemoryMb: clusterId && reserveMem ? Number(reserveMem) : null,
        reserveCpus: clusterId && reserveCpu ? Number(reserveCpu) : null,
        // Classic-only docker-run limits; a clustered app sends null so a stale value is cleared (always allowed).
        memorySwapMb: !clusterId && swap ? Number(swap) : null,
        pidsLimit: !clusterId && pids ? Number(pids) : null,
        shmSizeMb: !clusterId && shm ? Number(shm) : null,
        cpuShares: !clusterId && shares ? Number(shares) : null,
        cpusetCpus: !clusterId && cpusetTrim ? cpusetTrim : null,
        gpus: gpu.trim() || null,
        deployTimeoutSec: timeout ? Number(timeout) : null,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["app", id] }),
    ...feedback,
  });

  const item = { flex: "1 1 160px", minWidth: 0 } as const;

  return (
    <ConfigCard title={t("apps.limits")} desc={t("apps.limitsDesc")} dirty={dirty} saving={save.isPending} onSave={() => save.mutate()} saveDisabled={invalid}>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <Field label={t("apps.memoryMb")} style={item}>
          <NumberInput min={0} value={mem} onChange={(e) => setMem(e.target.value)} />
        </Field>
        <Field label={t("apps.cpus")} style={item}>
          <NumberInput min={0} step="0.1" value={cpu} onChange={(e) => setCpu(e.target.value)} />
        </Field>
        {clusterId && (
          <>
            <Field label={t("apps.reserveMemoryMb")} style={item}>
              <NumberInput min={0} value={reserveMem} onChange={(e) => setReserveMem(e.target.value)} />
            </Field>
            <Field label={t("apps.reserveCpus")} style={item}>
              <NumberInput min={0} step="0.1" value={reserveCpu} onChange={(e) => setReserveCpu(e.target.value)} />
            </Field>
          </>
        )}
        <Field label={t("apps.gpus")} style={{ flex: "1 1 220px", minWidth: 0 }}>
          <TextInput value={gpu} onChange={(e) => setGpu(e.target.value)} spellCheck={false} autoComplete="off" />
        </Field>
        <Field label={t("apps.deployTimeout")} style={item}>
          <NumberInput min={0} value={timeout} onChange={(e) => setTimeoutS(e.target.value)} />
        </Field>
      </div>
      {serverId && !clusterId && <GpuHints serverId={serverId} value={gpu} onPick={setGpu} />}
      {!clusterId && (
        <>
          <div style={{ margin: "16px 0 8px", fontSize: 12, fontWeight: 600, color: "var(--c-tx3)" }}>{t("apps.limitsAdvanced")}</div>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <Field label={t("apps.memorySwapMb")} hint={t("apps.memorySwapHint")} error={swapRangeBad ? t("apps.limitSwapRange") : swapNeedsMemory ? t("apps.limitSwapNeedsMemory") : swapBelowMemory ? t("apps.limitSwapBelowMemory") : undefined} style={item}>
              <NumberInput min={-1} value={swap} onChange={(e) => setSwap(e.target.value)} />
            </Field>
            <Field label={t("apps.pidsLimit")} hint={t("apps.pidsLimitHint")} error={pidsRangeBad ? t("apps.limitPidsRange") : undefined} style={item}>
              <NumberInput min={-1} value={pids} onChange={(e) => setPids(e.target.value)} />
            </Field>
            <Field label={t("apps.shmSizeMb")} hint={t("apps.shmSizeHint")} style={item}>
              <NumberInput min={1} value={shm} onChange={(e) => setShm(e.target.value)} />
            </Field>
            <Field label={t("apps.cpuShares")} hint={t("apps.cpuSharesHint")} style={item}>
              <NumberInput min={2} value={shares} onChange={(e) => setShares(e.target.value)} />
            </Field>
            <Field label={t("apps.cpusetCpus")} hint={t("apps.cpusetHint")} error={cpusetOk ? undefined : t("apps.limitCpusetInvalid")} style={item}>
              <TextInput value={cpuset} onChange={(e) => setCpuset(e.target.value)} spellCheck={false} autoComplete="off" />
            </Field>
          </div>
          <p style={{ margin: "12px 0 0", fontSize: 12, color: "var(--c-tx3)" }}>{t("apps.limitsPrecedenceHint")}</p>
        </>
      )}
    </ConfigCard>
  );
}

const chipStyle = { fontFamily: "inherit", fontSize: 12, padding: "3px 10px", borderRadius: 999, border: "1px solid var(--c-bd)", background: "var(--c-el)", color: "var(--c-tx)", cursor: "pointer" } as const;

/**
 * Advisory-only GPU awareness under the GPUs field: what was detected on this app's server, one-click suggestions and a
 * soft warning when the value doesn't match. It never blocks Save or alters the payload — the snapshot can be stale and
 * Jetson/vGPU/LXC hosts report oddly, so the hub stays the only validator. Unknown never nags.
 */
function GpuHints({ serverId, value, onPick }: { serverId: string; value: string; onPick: (v: string) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: gpusQueryKey(serverId), queryFn: () => api.getServerGpus(serverId), staleTime: 30_000, retry: false });
  const [err, setErr] = useState<string | null>(null);
  const redetect = useMutation({
    mutationFn: () => api.refreshServerGpus(serverId),
    onSuccess: (r) => {
      setErr(null);
      qc.setQueryData(gpusQueryKey(serverId), r);
    },
    onError: (e: unknown) => setErr(t(`servers.gpus.${gpuErrorKey(e)}`)),
  });
  const report = q.data;
  if (!report) return null;
  const real = (report.inventory?.gpus ?? []).filter((g) => g.kind === "gpu");
  const smi = real.filter((g) => g.source === "nvidia-smi");
  const advice = gpusAdvice(value, report, null);
  const label = (g: (typeof real)[number]) =>
    [g.index != null ? t("servers.gpus.gpuLabel", { index: g.index }) : (g.pci ?? ""), g.name, g.memoryMb != null ? t("servers.gpus.memory", { gb: gpuMemoryGb(g.memoryMb) }) : ""].filter(Boolean).join(" ");
  const chips: { value: string; text: string }[] = [];
  if (smi.length > 0) {
    chips.push({ value: "all", text: "all" });
    for (let n = 1; n <= Math.min(smi.length, 8); n++) chips.push({ value: String(n), text: String(n) });
    for (const g of smi.slice(0, 8)) {
      if (g.index != null) chips.push({ value: `device=${g.index}`, text: `device=${g.index}` });
      if (g.uuid) chips.push({ value: `device=${g.uuid}`, text: `device=${g.uuid.slice(0, 12)}…` });
    }
  }
  return (
    <div style={{ marginTop: 8, fontSize: 12.5, color: "var(--c-tx3)" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
          {report.readiness === "unknown" ? t("apps.gpusNotChecked") : real.length === 0 ? t("apps.gpusNone") : t("apps.gpusDetected", { list: real.map(label).join(", ") })}
        </span>
        <button type="button" style={chipStyle} disabled={redetect.isPending} onClick={() => redetect.mutate()}>
          {redetect.isPending ? t("apps.gpusRedetecting") : t("apps.gpusRedetect")}
        </button>
      </div>
      {chips.length > 0 && (
        <div role="group" aria-label={t("apps.gpusSuggest")} style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
          {chips.map((c) => (
            <button key={c.value} type="button" style={chipStyle} title={c.value} onClick={() => onPick(c.value)}>{c.text}</button>
          ))}
        </div>
      )}
      {advice && (
        <p role="note" style={{ margin: "6px 0 0", color: "var(--c-am)" }}>{t(`apps.gpusAdvice_${advice.key}`, advice.params)}</p>
      )}
      {err && <p role="alert" style={{ margin: "6px 0 0", color: "var(--c-r)" }}>{err}</p>}
    </div>
  );
}
