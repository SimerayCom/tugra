"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useT } from "../i18n/provider";
import { ConfigCard, Field, NumberInput, TextInput, useSaveFeedback } from "./form";

/**
 * Optional CPU/memory limits (+ Swarm reservation hints) and the deploy timeout. Every field now
 * carries a visible label — the inputs used to be placeholder-only, so they had no accessible name
 * at all — and Save is gated until something actually changes.
 */
export function LimitsCard({ id, memoryMb, cpus, reserveMemoryMb, reserveCpus, memorySwapMb, pidsLimit, shmSizeMb, cpuShares, cpusetCpus, gpus, deployTimeoutSec, clusterId }: {
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
