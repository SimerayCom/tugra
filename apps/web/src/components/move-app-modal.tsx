"use client";

import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ApiError, api } from "../lib/api";
import { fmtBytes } from "../lib/fleet";
import {
  RETAIN_CHOICES,
  ackLabelKey,
  ackPayload,
  canContinue,
  codeText,
  detailVars,
  fmtSeconds,
  splitBlockers,
  targetChoices,
} from "../lib/app-move";
import type { MovePreflightResult } from "../lib/types";
import { useT } from "../i18n/provider";
import { useToast } from "./toast";
import { Modal } from "./modal";
import { Btn, Working } from "./ui";
import { Checkbox, Select, fieldStyle } from "./form";
import { TypedConfirmField } from "./typed-confirm-field";

type Step = "target" | "review" | "confirm";
const STEPS: Step[] = ["target", "review", "confirm"];

const sectionTitle = { fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--c-tx3)", margin: "14px 0 6px" } as const;

/**
 * Move an app to another server in three steps: (1) pick the target (same team, current excluded, offline disabled) and
 * run the read-only preflight, (2) review what will happen (blockers, warnings, the plan, acknowledgements, options),
 * (3) confirm by typing the app's name. The hub re-runs the whole preflight when the move starts, so what is shown here is
 * advisory; a stale result comes back as a 409 with the fresh one and the dialog returns to the review step.
 */
export function MoveAppModal({
  appId,
  appName,
  teamId,
  currentServerId,
  onClose,
  onStarted,
}: {
  appId: string;
  appName: string;
  teamId: string;
  currentServerId: string;
  onClose: () => void;
  onStarted?: (moveId: string) => void;
}) {
  const t = useT();
  const toast = useToast();
  const [step, setStep] = useState<Step>("target");
  const [targetId, setTargetId] = useState("");
  const [result, setResult] = useState<MovePreflightResult | undefined>();
  const [acks, setAcks] = useState<Record<string, boolean>>({});
  const [repointDns, setRepointDns] = useState(false);
  const [retain, setRetain] = useState(7);
  const [typed, setTyped] = useState("");

  const { data: servers = [], isLoading: loadingServers } = useQuery({ queryKey: ["servers", teamId], queryFn: () => api.listServers({ teamId }) });
  const choices = targetChoices(servers, currentServerId, teamId, { offline: t("apps.moveServerOffline"), readOnly: t("servers.cta.tagNoWrite"), capability: t("servers.cta.tagCapability") });

  const check = useMutation({
    mutationFn: (probeLink: boolean) => api.previewAppMove(appId, { targetServerId: targetId, probeLink }),
    onSuccess: (r) => {
      setResult(r);
      setStep("review");
    },
  });
  const start = useMutation({
    mutationFn: () =>
      api.startAppMove(appId, { targetServerId: targetId, acknowledge: ackPayload(result, acks), repointDns, archiveRetainDays: retain, confirmName: typed }),
    onSuccess: (r) => {
      toast(t("apps.moveStarted"), "success");
      onStarted?.(r.moveId);
      onClose();
    },
    onError: (e) => {
      // a stale preflight: the hub returns the fresh result — show it and let the operator decide again
      const fresh = e instanceof ApiError && e.code === "preflight_failed" ? (e.data?.preflight as MovePreflightResult | undefined) : undefined;
      if (fresh) {
        setResult(fresh);
        setStep("review");
      }
    },
  });

  /** Acknowledgements, the DNS choice and the typed name are consequences of ONE target: choosing a different one starts
   *  them over, so a box ticked for target A is never silently carried into B's review. The same target (Back, then
   *  Continue; Recheck; a 409's fresh result) keeps them. */
  const pickTarget = (id: string): void => {
    if (id === targetId) return;
    setTargetId(id);
    setResult(undefined);
    setAcks({});
    setRepointDns(false);
    setTyped("");
  };

  const target = choices.find((c) => c.value === targetId);
  const split = result ? splitBlockers(result) : undefined;
  const ready = canContinue(result, acks as never);
  const stepIdx = STEPS.indexOf(step);
  const cheap = !!result?.plan.cheap;

  return (
    <Modal onClose={onClose} width={640} ariaLabel={t("apps.moveTitle")} cardStyle={{ maxWidth: "calc(100vw - 16px)", maxHeight: "calc(100dvh - 16px)", overflowY: "auto" }}>
      <h3 style={{ margin: "0 0 4px", fontSize: 15 }}>{t("apps.moveTitle")}</h3>
      <ol aria-label={t("apps.moveTitle")} style={{ display: "flex", gap: 6, listStyle: "none", padding: 0, margin: "0 0 12px", flexWrap: "wrap" }}>
        {STEPS.map((s, i) => (
          <li key={s} aria-current={i === stepIdx ? "step" : undefined} style={{ fontSize: 12, fontWeight: i === stepIdx ? 700 : 500, color: i <= stepIdx ? "var(--c-tx)" : "var(--c-tx3)" }}>
            {i + 1}. {t(`apps.moveStep_${s}`)}
            {i < STEPS.length - 1 ? " ›" : ""}
          </li>
        ))}
      </ol>

      {step === "target" && (
        <>
          <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px", lineHeight: 1.5 }}>{t("apps.moveDesc")}</p>
          {loadingServers ? (
            <Working text={t("apps.moveLoadingTargets")} />
          ) : choices.length === 0 ? (
            <p role="status" style={{ fontSize: 13, color: "var(--c-am)" }}>
              {t("apps.moveNoTargets")} <Link href="/servers/new" style={{ color: "var(--c-lapis)" }}>{t("servers.cta.addServer")}</Link>
            </p>
          ) : (
            <label style={{ display: "block", marginBottom: 12 }}>
              <span style={{ display: "block", fontSize: 12, color: "var(--c-tx2)", marginBottom: 6 }}>{t("apps.movePickTarget")}</span>
              <select aria-label={t("apps.movePickTarget")} value={targetId} onChange={(e) => pickTarget(e.target.value)} style={fieldStyle}>
                <option value="" disabled>{t("common.select")}</option>
                {choices.map((c) => (
                  <option key={c.value} value={c.value} disabled={c.disabled}>{c.label}</option>
                ))}
              </select>
            </label>
          )}
          {check.isPending && <p role="status" style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("apps.movePreflightRunning")}</p>}
          {check.isError && <div role="alert" style={{ color: "var(--c-r)", fontSize: 12, marginBottom: 8 }}>{(check.error as Error).message}</div>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Btn variant="ghost" onClick={onClose}>{t("apps.moveCancel")}</Btn>
            <Btn onClick={() => check.mutate(false)} loading={check.isPending} disabled={!targetId || !!target?.disabled}>{t("apps.moveContinue")}</Btn>
          </div>
        </>
      )}

      {step === "review" && result && split && (
        <>
          <p style={{ fontSize: 13, margin: "0 0 4px" }}>
            {result.plan.cheap ? t("apps.moveDowntimeNone") : t("apps.moveDowntime", { low: fmtSeconds(result.plan.estimatedDowntimeSec.low), high: fmtSeconds(result.plan.estimatedDowntimeSec.high) })}
          </p>
          {!cheap && <p style={{ fontSize: 12, color: "var(--c-am)", margin: "0 0 4px", lineHeight: 1.5 }}>{t("apps.moveColdMoveNotice")}</p>}

          {split.hard.length > 0 && (
            <>
              <div style={sectionTitle}>{t("apps.moveBlockers")}</div>
              <ul aria-label={t("apps.moveBlockers")} style={{ margin: 0, paddingLeft: 18, color: "var(--c-r)", fontSize: 13, lineHeight: 1.5 }}>
                {split.hard.map((b, i) => (
                  <li key={`${b.code}-${i}`}>{codeText(t, "Blocker", b.code, b.message, detailVars(b.details))}</li>
                ))}
              </ul>
            </>
          )}

          {result.requiredAcks.length > 0 && (
            <>
              <div style={sectionTitle}>{t("apps.moveBlockersAck")}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {split.needsAck.map((b, i) => (
                  <p key={`${b.code}-${i}`} style={{ margin: 0, fontSize: 12, color: "var(--c-tx3)" }}>{codeText(t, "Blocker", b.code, b.message, detailVars(b.details))}</p>
                ))}
                {result.requiredAcks.map((a) => (
                  <Checkbox key={a} checked={!!acks[a]} onChange={(v) => setAcks({ ...acks, [a]: v })} label={t(ackLabelKey(a))} />
                ))}
              </div>
            </>
          )}

          {result.warnings.filter((w) => w.code !== "downtime_estimate").length > 0 && (
            <>
              <div style={sectionTitle}>{t("apps.moveWarnings")}</div>
              <ul aria-label={t("apps.moveWarnings")} style={{ margin: 0, paddingLeft: 18, color: "var(--c-am)", fontSize: 12.5, lineHeight: 1.5 }}>
                {result.warnings
                  .filter((w) => w.code !== "downtime_estimate")
                  .map((w, i) => (
                    <li key={`${w.code}-${i}`}>{codeText(t, "Warn", w.code, "", detailVars(w.details))}</li>
                  ))}
              </ul>
            </>
          )}

          <div style={sectionTitle}>{t("apps.movePlan")}</div>
          <div style={{ fontSize: 12.5, color: "var(--c-tx2)", display: "flex", flexDirection: "column", gap: 4 }}>
            {!cheap && result.plan.totalBytes > 0 && <span>{t("apps.moveTotalSize", { size: fmtBytes(result.plan.totalBytes), parts: result.plan.estimatedParts })}</span>}
            {result.plan.domain.from !== result.plan.domain.to && (
              <span>{t("apps.moveDomainChange", { from: result.plan.domain.from ?? t("apps.moveDomainNone"), to: result.plan.domain.to ?? t("apps.moveDomainNone") })}</span>
            )}
            {result.plan.hostPort.from !== result.plan.hostPort.to && (
              <span>{t("apps.moveHostPortChange", { from: result.plan.hostPort.from ?? "—", to: result.plan.hostPort.to ?? "—" })}</span>
            )}
            {result.plan.targetIp && <span>{t("apps.moveTargetIp", { ip: result.plan.targetIp })}</span>}
            {result.plan.link && <span>{result.plan.link.ok ? t("apps.moveLinkResult", { mbps: result.plan.link.mbps ?? "?" }) : t("apps.moveLinkFailed")}</span>}
          </div>

          <div style={sectionTitle}>{t("apps.moveVolumes")}</div>
          {result.plan.volumes.length === 0 ? (
            <p style={{ fontSize: 12.5, color: "var(--c-tx3)", margin: 0 }}>{t("apps.moveNoVolumes")}</p>
          ) : (
            // one bordered card per volume: reads as a table on desktop and wraps cleanly into stacked cards on a phone
            <ul aria-label={t("apps.moveVolumes")} style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
              {result.plan.volumes.map((v) => (
                <li key={v.dockerName} style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: "8px 10px", display: "flex", flexWrap: "wrap", gap: "4px 14px", fontSize: 12.5 }}>
                  <strong className="mono">{v.name}</strong>
                  <span>{v.sizeBytes != null ? fmtBytes(v.sizeBytes) : "—"}</span>
                  <span style={{ color: "var(--c-tx3)" }}>{t(`apps.moveVolState_${v.state}`)}</span>
                </li>
              ))}
            </ul>
          )}

          {!cheap && (
            <div style={{ marginTop: 10 }}>
              <Btn variant="ghost" onClick={() => check.mutate(true)} loading={check.isPending}>
                {check.isPending ? t("apps.moveProbeRunning") : t("apps.moveProbeLink")}
              </Btn>
            </div>
          )}

          <div style={sectionTitle}>{t("apps.moveOptions")}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <Checkbox checked={repointDns} onChange={setRepointDns} label={t("apps.moveRepointDns")} />
            {!cheap && (
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--c-tx2)", flexWrap: "wrap" }}>
                {t("apps.moveRetainDays")}
                <Select
                  value={String(retain)}
                  onChange={(v) => setRetain(Number(v))}
                  options={RETAIN_CHOICES.map((n) => ({ value: String(n), label: n === 0 ? t("apps.moveRetainOption_0") : t("apps.moveRetainOption_n", { n }) }))}
                  ariaLabel={t("apps.moveRetainDays")}
                  style={{ width: "auto" }}
                />
              </label>
            )}
          </div>

          {check.isError && <div role="alert" style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(check.error as Error).message}</div>}
          <div style={{ display: "flex", gap: 8, justifyContent: "space-between", flexWrap: "wrap", marginTop: 14 }}>
            <Btn variant="ghost" onClick={() => setStep("target")}>{t("apps.moveBack")}</Btn>
            <div style={{ display: "flex", gap: 8 }}>
              <Btn variant="ghost" onClick={() => check.mutate(false)} loading={check.isPending}>{t("apps.moveRecheck")}</Btn>
              <Btn onClick={() => setStep("confirm")} disabled={!ready}>{t("apps.moveContinue")}</Btn>
            </div>
          </div>
        </>
      )}

      {step === "confirm" && (
        <>
          {!cheap && <p style={{ fontSize: 12.5, color: "var(--c-am)", margin: "0 0 12px", lineHeight: 1.5 }}>{t("apps.moveColdMoveNotice")}</p>}
          <TypedConfirmField
            autoFocus
            expected={appName}
            value={typed}
            onChange={setTyped}
            onEnter={() => { if (typed === appName && !start.isPending) start.mutate(); }}
            label={t("apps.moveConfirmLabel")}
            hint={<strong className="mono">{appName}</strong>}
          />
          {start.isError && !(start.error instanceof ApiError && start.error.code === "preflight_failed") && (
            <div role="alert" style={{ color: "var(--c-r)", fontSize: 12, marginBottom: 8 }}>{(start.error as Error).message || t("apps.moveStartFailed")}</div>
          )}
          <div style={{ display: "flex", gap: 8, justifyContent: "space-between" }}>
            <Btn variant="ghost" onClick={() => setStep("review")} disabled={start.isPending}>{t("apps.moveBack")}</Btn>
            <Btn onClick={() => start.mutate()} loading={start.isPending} disabled={typed !== appName}>{t("apps.moveSubmit")}</Btn>
          </div>
        </>
      )}
    </Modal>
  );
}
