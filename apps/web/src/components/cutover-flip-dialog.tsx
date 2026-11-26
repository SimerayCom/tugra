"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type CutoverEntryView, type CutoverFlipPlanRecord } from "../lib/api";
import { useT } from "../i18n/provider";
import { useDebounce } from "../hooks/useDebounce";
import { hasHttp01Gap, tCode, WARN_KEY, BLOCK_KEY } from "../lib/cutover";
import { useToast } from "./toast";
import { Btn, Spinner } from "./ui";
import { Modal } from "./modal";
import { CutoverTtlGuidance } from "./cutover-ttl-guidance";
import { CutoverSourceStop } from "./cutover-source-stop";
import { TypedConfirmField } from "./typed-confirm-field";

const ACTION_KEY: Record<CutoverFlipPlanRecord["action"], string> = {
  create: "cutover.flip.recordCreate",
  update: "cutover.flip.recordUpdate",
  delete: "cutover.flip.recordDelete",
  noop: "cutover.flip.recordNoop",
};

const intIn = (raw: string, min: number, max: number): number | null => {
  if (!/^\d+$/.test(raw.trim())) return null;
  const n = Number(raw);
  return n >= min && n <= max ? n : null;
};

/**
 * Plan + confirm the DNS flip. The record diff comes from the hub's flip-plan; the flip button stays disabled until
 * the plan for the CURRENT inputs has loaded, the op id is typed, and every acknowledgement the plan needs is ticked.
 * confirmToken is the plan's own hash, so the hub refuses a flip whose plan changed underneath the owner.
 */
export function CutoverFlipDialog({ opId, hostnames, entries, onClose }: { opId: string; hostnames: string[]; entries: CutoverEntryView[]; onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const [batchSize, setBatchSize] = useState("5");
  const [intervalSec, setIntervalSec] = useState("30");
  const [targetTtl, setTargetTtl] = useState("60");
  const [stopOnFail, setStopOnFail] = useState(true);
  const [autoRevert, setAutoRevert] = useState(false);
  const [keepProxied, setKeepProxied] = useState(true);
  const [skipTtlWait, setSkipTtlWait] = useState(false);
  const [ackData, setAckData] = useState(false);
  const [ackGap, setAckGap] = useState(false);
  const [typed, setTyped] = useState("");

  const batchN = intIn(batchSize, 1, 25);
  const intervalN = intIn(intervalSec, 5, 600);
  const ttlN = intIn(targetTtl, 60, 3600);
  const planTtl = useDebounce(ttlN, 400);
  const planKeep = useDebounce(keepProxied, 400);
  const inputsValid = batchN !== null && intervalN !== null && ttlN !== null;
  const planStale = planTtl !== ttlN || planKeep !== keepProxied;

  const planQ = useQuery({
    queryKey: ["cutover-flip-plan", opId, hostnames.join(","), planTtl, planKeep],
    queryFn: () => api.getCutoverFlipPlan(opId, { hostnames, ...(planTtl !== null ? { targetTtl: planTtl } : {}), keepProxied: planKeep }),
    enabled: planTtl !== null,
    staleTime: 0,
    gcTime: 0,
  });
  const plan = planQ.data;
  const byHost = new Map(entries.map((e) => [e.hostname, e]));
  const planned = plan?.entries ?? [];
  const stateful = planned.some((p) => p.warnings.includes("stateful") || byHost.get(p.hostname)?.stateful);
  const http01Gap = planned.some((p) => p.warnings.includes("http01-gap") || (p.challenge === "http01" && !!byHost.get(p.hostname) && hasHttp01Gap(byHost.get(p.hostname)!)));
  const typedOk = typed.trim() === opId;

  const flip = useMutation({
    mutationFn: () =>
      api.cutoverFlip(opId, {
        confirmToken: plan!.planHash,
        hostnames,
        batchSize: batchN!,
        intervalSec: intervalN!,
        targetTtl: ttlN!,
        stopOnFail,
        autoRevert,
        keepProxied,
        ...(skipTtlWait ? { skipTtlWait: true } : {}),
        ...(stateful ? { acceptDataRisk: ackData } : {}),
        ...(http01Gap ? { acceptHttp01Gap: ackGap } : {}),
      }),
    onSuccess: () => {
      toast(t("cutover.flip.queued"), "success");
      void qc.invalidateQueries({ queryKey: ["cutover", opId] });
      onClose();
    },
  });

  const ready = !!plan && !planStale && !planQ.isFetching && planned.length > 0 && inputsValid && typedOk && (!stateful || ackData) && (!http01Gap || ackGap) && !flip.isPending;
  const fmt = (r: CutoverFlipPlanRecord["new"]) => (r ? t(r.proxied ? "cutover.flip.valueProxied" : "cutover.flip.value", { content: r.content, ttl: r.ttl }) : t("cutover.flip.none"));

  return (
    <Modal onClose={onClose} width={760} labelledBy="cutover-flip-title" closeOnBackdrop={false}>
      <h2 id="cutover-flip-title" style={{ fontSize: 15, fontWeight: 700, margin: "0 0 6px" }}>{t("cutover.flip.title")}</h2>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px", lineHeight: 1.5 }}>{t("cutover.flip.honest")}</p>

      {planQ.isLoading || (planQ.isFetching && !plan) ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--c-tx3)", marginBottom: 12 }}><Spinner /> {t("cutover.flip.loadingPlan")}</div>
      ) : planQ.isError ? (
        <div role="alert" style={{ color: "var(--c-r)", fontSize: 12, marginBottom: 12 }}>{(planQ.error as Error).message}</div>
      ) : null}

      {plan && (
        <>
          <div style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 8px" }}>
            {t("cutover.flip.summary", { count: planned.length, minutes: Math.max(1, Math.ceil(plan.rate.estimatedSeconds / 60)) })}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
            {planned.map((p) => (
              <div key={p.hostname} style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: 10 }}>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "baseline" }}>
                  <span className="mono" style={{ fontWeight: 600, fontSize: 13, wordBreak: "break-all" }}>{p.hostname}</span>
                  <span style={{ fontSize: 11, color: "var(--c-tx3)" }}>{p.appName}</span>
                </div>
                <ul style={{ margin: "6px 0 0", padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 3 }}>
                  {p.records.map((r, i) => (
                    <li key={i} style={{ fontSize: 11, wordBreak: "break-all", color: r.action === "delete" ? "var(--c-r)" : r.action === "noop" ? "var(--c-tx3)" : "var(--c-tx2)" }}>
                      <strong>{t(ACTION_KEY[r.action])}</strong> <span className="mono">{r.type} {r.name}</span>: <span className="mono">{fmt(r.old)}</span> → <span className="mono" style={{ color: r.action === "delete" ? "var(--c-r)" : "var(--c-g)" }}>{r.action === "delete" ? t("cutover.flip.none") : fmt(r.new)}</span>
                    </li>
                  ))}
                </ul>
                {p.warnings.length > 0 && (
                  <ul style={{ margin: "6px 0 0", paddingLeft: 16, fontSize: 11, color: "var(--c-am)" }}>
                    {p.warnings.map((w) => <li key={w}>{tCode(t, WARN_KEY, w)}</li>)}
                  </ul>
                )}
              </div>
            ))}
          </div>
          {plan.blocked.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "var(--c-r)", marginBottom: 4 }}>{t("cutover.flip.blocked", { count: plan.blocked.length })}</div>
              <ul style={{ margin: 0, paddingLeft: 16, fontSize: 11, color: "var(--c-tx3)" }}>
                {plan.blocked.map((b) => <li key={b.hostname}><span className="mono">{b.hostname}</span>: {tCode(t, BLOCK_KEY, b.reason)}</li>)}
              </ul>
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 12 }}>
            <CutoverTtlGuidance records={plan.copyPaste} />
            <CutoverSourceStop items={plan.sourceStop} stateful={stateful} />
          </div>
        </>
      )}

      <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 12, lineHeight: 1.5 }}>
        <div style={{ fontWeight: 700, color: "var(--c-tx2)" }}>{t("cutover.flip.notesTitle")}</div>
        <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
          <li>{t("cutover.flip.noteStaleTtl")}</li>
          <li>{t("cutover.flip.noteProxiedTtl")}</li>
          <li>{t("cutover.warn.quiesceSource")}</li>
        </ul>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginBottom: 12 }}>
        <NumField id="cutover-batch" label={t("cutover.flip.batchSize")} value={batchSize} onChange={setBatchSize} bad={batchN === null} hint={t("cutover.flip.rangeHint", { min: 1, max: 25 })} />
        <NumField id="cutover-interval" label={t("cutover.flip.interval")} value={intervalSec} onChange={setIntervalSec} bad={intervalN === null} hint={t("cutover.flip.rangeHint", { min: 5, max: 600 })} />
        <NumField id="cutover-ttl" label={t("cutover.flip.targetTtl")} value={targetTtl} onChange={setTargetTtl} bad={ttlN === null} hint={t("cutover.flip.rangeHint", { min: 60, max: 3600 })} />
      </div>

      <Check checked={stopOnFail} onChange={setStopOnFail} label={t("cutover.flip.stopOnFail")} />
      <Check checked={keepProxied} onChange={setKeepProxied} label={t("cutover.flip.keepProxied")} />
      <Check checked={autoRevert} onChange={setAutoRevert} label={t("cutover.flip.autoRevert")} hint={t("cutover.flip.autoRevertWarn")} />
      <Check checked={skipTtlWait} onChange={setSkipTtlWait} label={t("cutover.flip.skipTtlWait")} />

      {stateful && <Check checked={ackData} onChange={setAckData} label={t("cutover.flip.acceptDataRisk")} tone="warn" />}
      {http01Gap && <Check checked={ackGap} onChange={setAckGap} label={t("cutover.flip.acceptHttp01Gap")} tone="warn" />}

      <TypedConfirmField expected={opId} value={typed} onChange={setTyped} label={t("cutover.flip.confirmType", { id: opId })} />

      {flip.isError && <div role="alert" style={{ color: "var(--c-r)", fontSize: 12, marginBottom: 10 }}>{(flip.error as Error).message}</div>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
        <Btn variant="ghost" onClick={onClose} disabled={flip.isPending}>{t("common.cancel")}</Btn>
        <Btn onClick={() => flip.mutate()} disabled={!ready} loading={flip.isPending}>{t("cutover.action.flip")}</Btn>
      </div>
    </Modal>
  );
}

function NumField({ id, label, value, onChange, bad, hint }: { id: string; label: string; value: string; onChange: (v: string) => void; bad: boolean; hint: string }) {
  return (
    <label htmlFor={id} style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--c-tx2)" }}>
      {label}
      <input id={id} inputMode="numeric" value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={bad || undefined} style={{ ...fieldStyle, ...(bad ? { borderColor: "var(--c-r)" } : {}) }} />
      <span style={{ fontSize: 11, color: bad ? "var(--c-r)" : "var(--c-tx3)" }}>{hint}</span>
    </label>
  );
}

function Check({ checked, onChange, label, hint, tone }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; tone?: "warn" }) {
  return (
    <label style={{ display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 10, fontSize: 13, color: tone === "warn" ? "var(--c-am)" : "var(--c-tx2)", cursor: "pointer", lineHeight: 1.5 }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} style={{ marginTop: 2, accentColor: "var(--c-a)", flexShrink: 0 }} />
      <span>
        {label}
        {hint && <span style={{ display: "block", fontSize: 11, color: "var(--c-tx3)" }}>{hint}</span>}
      </span>
    </label>
  );
}

const fieldStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "7px 9px",
  fontSize: 13,
  background: "var(--c-el)",
  border: "1px solid var(--c-bd)",
  borderRadius: "var(--r1)",
  color: "var(--c-tx)",
  fontFamily: "inherit",
};
