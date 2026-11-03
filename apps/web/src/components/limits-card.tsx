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
export function LimitsCard({ id, memoryMb, cpus, reserveMemoryMb, reserveCpus, gpus, deployTimeoutSec, clusterId }: {
  id: string;
  memoryMb: number | null;
  cpus: number | null;
  reserveMemoryMb: number | null;
  reserveCpus: number | null;
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
  const [gpu, setGpu] = useState(gpus ?? "");
  const [timeout, setTimeoutS] = useState(numStr(deployTimeoutSec));

  // Dirty vs the current server values, so Save enables on a real edit and settles after a save.
  const dirty =
    mem !== numStr(memoryMb) ||
    cpu !== numStr(cpus) ||
    gpu.trim() !== (gpus ?? "") ||
    timeout !== numStr(deployTimeoutSec) ||
    (!!clusterId && (reserveMem !== numStr(reserveMemoryMb) || reserveCpu !== numStr(reserveCpus)));

  const save = useMutation({
    mutationFn: () =>
      api.setAppLimits(id, {
        memoryMb: mem ? Number(mem) : null,
        cpus: cpu ? Number(cpu) : null,
        // Swarm-only reservation hints; only sent for a clustered app (fields are hidden otherwise).
        reserveMemoryMb: clusterId && reserveMem ? Number(reserveMem) : null,
        reserveCpus: clusterId && reserveCpu ? Number(reserveCpu) : null,
        gpus: gpu.trim() || null,
        deployTimeoutSec: timeout ? Number(timeout) : null,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["app", id] }),
    ...feedback,
  });

  const item = { flex: "1 1 160px", minWidth: 0 } as const;

  return (
    <ConfigCard title={t("apps.limits")} desc={t("apps.limitsDesc")} dirty={dirty} saving={save.isPending} onSave={() => save.mutate()}>
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
    </ConfigCard>
  );
}
