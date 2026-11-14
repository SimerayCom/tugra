"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Rocket } from "lucide-react";
import { api } from "../../../lib/api";
import { useT } from "../../../i18n/provider";
import { scopeByTeam } from "../../../lib/team-scope";
import { useTeamScope } from "../../../components/team-scope";
import { isRolloutActive, parseSteps, rolloutProgressPct, rolloutStatusColor } from "../../../lib/rollouts";
import { relativeTime } from "../../../lib/fleet";
import type { Application, Rollout, RolloutCreateInput, RolloutPlan } from "../../../lib/types";
import { Btn, EmptyState, StatusPill } from "../../../components/ui";
import { ErrorState } from "../../../components/error-state";
import { ListCard, ListRow } from "../../../components/list";
import { PageTitle } from "../../../components/page-header";
import { MeterBar } from "../../../components/meter-bar";
import { Modal } from "../../../components/modal";
import { Checkbox, Field, NumberInput, Select, TextInput } from "../../../components/form";
import { SkeletonTable } from "../../../components/skeleton";
import { useToast } from "../../../components/toast";

export default function RolloutsPage() {
  const t = useT();
  const router = useRouter();
  const { teamId } = useTeamScope();
  const [open, setOpen] = useState(false);
  const { data: rollouts, isLoading, isError, refetch } = useQuery({
    queryKey: ["rollouts"],
    queryFn: () => api.listRollouts(),
    // Live while anything is active; a quiet list polls slowly.
    refetchInterval: (q) => ((q.state.data ?? []).some((r) => isRolloutActive(r.status)) ? 3000 : 15000),
  });
  const scoped = scopeByTeam(rollouts ?? [], teamId);
  return (
    <div style={{ padding: "var(--page-pad)" }}>
      <PageTitle title={t("rollouts.title")} subtitle={t("rollouts.subtitle")} actions={<Btn onClick={() => setOpen(true)}>{t("rollouts.new")}</Btn>} />
      {isLoading && <SkeletonTable rows={4} />}
      {isError && !rollouts && <ErrorState onRetry={() => refetch()} />}
      {rollouts && (
        <ListCard>
          {scoped.length === 0 ? (
            <EmptyState icon={Rocket} title={t("rollouts.emptyTitle")}>
              {t("rollouts.empty")}
            </EmptyState>
          ) : (
            scoped.map((r, i) => <RolloutRow key={r.id} r={r} index={i} onOpen={() => router.push(`/rollouts/${r.id}`)} />)
          )}
        </ListCard>
      )}
      {open && <NewRolloutModal onClose={() => setOpen(false)} onCreated={(r) => router.push(`/rollouts/${r.id}`)} />}
    </div>
  );
}

function RolloutRow({ r, index, onOpen }: { r: Rollout; index: number; onOpen: () => void }) {
  const t = useT();
  const pct = rolloutProgressPct(r);
  const tone = r.status === "HALTED" ? "warn" : r.summary.failed > 0 ? "crit" : "ok";
  return (
    <ListRow index={index} onClick={onOpen} tabbable={false}>
      <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", width: "100%" }}>
        <div style={{ flex: 1, minWidth: 180 }}>
          <div style={{ fontWeight: 600 }}>{r.name ?? t("rollouts.unnamed", { id: r.id.slice(0, 6) })}</div>
          <div style={{ fontSize: 12, color: "var(--c-tx3)" }}>
            {t("rollouts.waveOf", { n: Math.min(r.currentWave + 1, r.waveCount), total: r.waveCount })} · {t("rollouts.targetsSummary", { ok: r.summary.succeeded, failed: r.summary.failed, pending: r.summary.pending + r.summary.deploying })}
          </div>
        </div>
        <MeterBar value={pct} tone={tone} text={`${pct}%`} width={120} label={t("rollouts.colProgress")} />
        <StatusPill label={t(`rollouts.status_${r.status}`)} color={rolloutStatusColor(r.status)} />
        <span style={{ fontSize: 12, color: "var(--c-tx3)", minWidth: 80, textAlign: "right" }}>{relativeTime(r.createdAt)}</span>
      </div>
    </ListRow>
  );
}

const stepsText = (steps: number[]) => steps.join(", ");

function NewRolloutModal({ onClose, onCreated }: { onClose: () => void; onCreated: (r: Rollout) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const { teamId: scopeTeam } = useTeamScope();
  const { data: teams = [] } = useQuery({ queryKey: ["teams"], queryFn: () => api.listTeams() });
  const { data: apps = [] } = useQuery({ queryKey: ["apps"], queryFn: () => api.listApps() });
  const [teamId, setTeamId] = useState<string>(scopeTeam ?? "");
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<string[]>([]); // ordered — the order IS the wave order
  const [canary, setCanary] = useState("1");
  const [steps, setSteps] = useState("25, 50, 100");
  const [concurrency, setConcurrency] = useState("3");
  const [maxFailures, setMaxFailures] = useState("0");
  const [bakeSec, setBakeSec] = useState("60");
  const [allowUngated, setAllowUngated] = useState(false);
  const [noCache, setNoCache] = useState(false);

  const effectiveTeam = teamId || teams[0]?.id || "";
  const teamApps = useMemo(() => (apps as Application[]).filter((a) => a.teamId === effectiveTeam).sort((a, b) => a.name.localeCompare(b.name)), [apps, effectiveTeam]);
  const parsedSteps = parseSteps(steps);
  const input: RolloutCreateInput | null = useMemo(() => {
    if (!picked.length || !parsedSteps) return null;
    return {
      ...(name.trim() ? { name: name.trim().slice(0, 80) } : {}),
      appIds: picked,
      config: {
        canary: Math.max(0, Math.min(10, Math.round(Number(canary) || 0))),
        steps: parsedSteps,
        concurrency: Math.max(1, Math.min(10, Math.round(Number(concurrency) || 1))),
        maxFailuresPerWave: Math.max(0, Math.round(Number(maxFailures) || 0)),
        bakeSec: Math.max(0, Math.min(3600, Math.round(Number(bakeSec) || 0))),
        allowUngated,
        noCache,
      },
    };
  }, [picked, parsedSteps, name, canary, concurrency, maxFailures, bakeSec, allowUngated, noCache]);

  // Dry-run plan: refreshed as the selection/config changes (debounced by react-query's key).
  const { data: plan, error: planError } = useQuery<RolloutPlan>({
    queryKey: ["rollout-plan", JSON.stringify(input)],
    queryFn: () => api.planRollout(input!),
    enabled: !!input,
    retry: false,
  });
  const create = useMutation({
    mutationFn: () => api.createRollout(input!),
    onSuccess: (r) => {
      toast(t("rollouts.created"), "success");
      qc.invalidateQueries({ queryKey: ["rollouts"] });
      onCreated(r);
    },
    onError: (e) => toast(e instanceof Error && e.message ? e.message : t("rollouts.actionFailed"), "error"),
  });
  const toggle = (id: string) => setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const blockedFor = (appId: string) => plan?.targets.find((p) => p.appId === appId);
  const canStart = !!input && !!plan && plan.blocked === 0 && plan.waveSizes.length > 0 && !create.isPending;

  return (
    <Modal onClose={() => !create.isPending && onClose()} ariaLabel={t("rollouts.new")} width={640}>
      <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>{t("rollouts.new")}</div>
        <p style={{ margin: 0, fontSize: 12, color: "var(--c-tx3)" }}>{t("rollouts.redeployNote")}</p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
          <Field label={t("rollouts.team")}>
            <Select
              value={effectiveTeam}
              onChange={(v) => {
                setTeamId(v);
                setPicked([]);
              }}
              options={teams.map((tm) => ({ value: tm.id, label: tm.name }))}
            />
          </Field>
          <Field label={t("rollouts.name")}>
            <TextInput value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          </Field>
        </div>
        <Field label={t("rollouts.pickApps")} hint={t("rollouts.pickAppsHint")}>
          <div style={{ maxHeight: 200, overflow: "auto", border: "1px solid var(--c-bd)", borderRadius: 8, padding: 8, display: "flex", flexDirection: "column", gap: 4 }}>
            {teamApps.length === 0 && <span style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("rollouts.noAppsForTeam")}</span>}
            {teamApps.map((a) => {
              const p = blockedFor(a.id);
              return (
                <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <Checkbox checked={picked.includes(a.id)} onChange={() => toggle(a.id)} label={a.name} />
                  {p?.blocked && <span style={{ fontSize: 11, color: "var(--c-r)" }}>{t(`rollouts.blocked_${p.blocked}`)}</span>}
                  {p && !p.blocked && p.wave != null && (
                    <span style={{ fontSize: 11, color: "var(--c-tx3)" }}>{p.wave === 0 && (plan?.waveSizes[0] ?? 0) < (plan?.targets.length ?? 0) && Number(canary) > 0 ? t("rollouts.canaryWave") : t("rollouts.wave", { n: p.wave + 1 })}</span>
                  )}
                  {p?.warnings.map((w) => (
                    <span key={w} style={{ fontSize: 11, color: "var(--c-am)" }}>
                      {t(`rollouts.warning_${w}`)}
                    </span>
                  ))}
                </div>
              );
            })}
          </div>
        </Field>
        <div style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("rollouts.selected", { n: picked.length })}</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
          <Field label={t("rollouts.canary")} hint={t("rollouts.canaryHint")}>
            <NumberInput min={0} max={10} value={canary} onChange={(e) => setCanary(e.target.value)} />
          </Field>
          <Field label={t("rollouts.steps")} hint={t("rollouts.stepsHint")} error={parsedSteps ? undefined : t("rollouts.invalidSteps")}>
            <TextInput value={steps} onChange={(e) => setSteps(e.target.value)} placeholder={stepsText([25, 50, 100])} />
          </Field>
          <Field label={t("rollouts.concurrency")}>
            <NumberInput min={1} max={10} value={concurrency} onChange={(e) => setConcurrency(e.target.value)} />
          </Field>
          <Field label={t("rollouts.maxFailures")}>
            <NumberInput min={0} max={50} value={maxFailures} onChange={(e) => setMaxFailures(e.target.value)} />
          </Field>
          <Field label={t("rollouts.bakeSec")} hint={t("rollouts.bakeHint")}>
            <NumberInput min={0} max={3600} value={bakeSec} onChange={(e) => setBakeSec(e.target.value)} />
          </Field>
        </div>
        <Checkbox checked={allowUngated} onChange={setAllowUngated} label={t("rollouts.allowUngated")} />
        <Checkbox checked={noCache} onChange={setNoCache} label={t("rollouts.noCache")} />
        <div style={{ fontSize: 12, color: "var(--c-tx2)" }}>
          {plan && plan.waveSizes.length > 0 && <div>{t("rollouts.previewWaves", { n: plan.waveSizes.length, sizes: plan.waveSizes.join(" → ") })}</div>}
          {plan && plan.blocked > 0 && <div style={{ color: "var(--c-r)" }}>{t("rollouts.blocked", { n: plan.blocked })}</div>}
          {planError && <div role="alert" style={{ color: "var(--c-r)" }}>{planError instanceof Error ? planError.message : t("rollouts.actionFailed")}</div>}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Btn variant="ghost" onClick={onClose} disabled={create.isPending}>
            {t("common.cancel")}
          </Btn>
          <Btn onClick={() => create.mutate()} disabled={!canStart} loading={create.isPending}>
            {create.isPending ? t("rollouts.starting") : t("rollouts.start")}
          </Btn>
        </div>
      </div>
    </Modal>
  );
}
