"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Gauge, TriangleAlert } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useT } from "../../i18n/provider";
import { Badge, Btn, Card, EmptyState, SectionCard } from "../ui";
import { Checkbox } from "../form";
import { Modal } from "../modal";
import { useToast } from "../toast";
import { formatMoney, guideKey, pct, providerName, rescaleActive, rescaleStep, type RescaleView, type ServerAdvice } from "../../lib/costs";
import { TypedConfirmField } from "../typed-confirm-field";

/** Size advice per server: "can go down to X, saves about Y a month", "near its limit", or still learning. */
export function SizeAdviceList({ advice, snapshotDate, canManage }: { advice: ServerAdvice[]; snapshotDate: string; canManage: boolean }) {
  const t = useT();
  const learning = advice.filter((a) => a.kind === "learning");
  const shown = advice.filter((a) => a.kind === "downsize" || a.kind === "near_limit");
  return (
    <SectionCard title={t("costs.advice.title")} desc={t("costs.advice.desc")}>
      {shown.length === 0 ? (
        learning.length === advice.length && advice.length > 0 ? null : <EmptyState icon={Gauge}>{t("costs.advice.allGood")}</EmptyState>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {shown.map((a) => (
            <AdviceCard key={a.serverId} a={a} snapshotDate={snapshotDate} canManage={canManage} />
          ))}
        </div>
      )}
      {learning.length > 0 && (
        <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: shown.length ? "12px 0 0" : 0 }}>
          {learning.length === 1
            ? t("costs.advice.learning", { days: learning[0].daysCollected, needed: learning[0].daysNeeded })
            : t("costs.advice.learningSummary", { n: learning.length })}
        </p>
      )}
    </SectionCard>
  );
}

function AdviceCard({ a, snapshotDate, canManage }: { a: ServerAdvice; snapshotDate: string; canManage: boolean }) {
  const t = useT();
  const [guideOpen, setGuideOpen] = useState(false);
  const [dialog, setDialog] = useState(false);
  const down = a.kind === "downsize";
  const target = a.target;
  const money = (n: number) => formatMoney(Math.abs(n), target?.currency ?? a.current?.currency ?? "EUR");
  const rescaleQ = useQuery({
    queryKey: ["costs-rescale", a.serverId],
    queryFn: () => api.getRescale(a.serverId),
    enabled: a.rescale === "api" || a.rescaleBlocked === "active",
    refetchInterval: (q) => (rescaleActive(q.state.data?.rescale?.phase) ? 4000 : false),
  });
  const move = rescaleQ.data?.rescale ?? null;
  const showMove = move && (rescaleActive(move.phase) || (move.finishedAt !== null && Date.now() - new Date(move.finishedAt).getTime() < 3_600_000));
  const provider = providerName(a.provider) ?? "";

  return (
    <Card style={{ padding: 14 }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 220px", minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontWeight: 600, fontSize: 14, overflowWrap: "anywhere" }}>{a.name}</span>
            <Badge tone={down ? "ok" : "warn"}>{down ? t("costs.advice.downsize", { plan: target?.slug.toUpperCase() ?? "" }) : t("costs.advice.nearLimit")}</Badge>
          </div>
          {down && target && (
            <div style={{ fontSize: 13, marginTop: 6 }}>
              <strong>{target.label}</strong>
              {a.savingsCents !== null && a.savingsCents > 0 && <span style={{ color: "var(--c-g)" }}> · {t("costs.advice.saves", { amount: money(a.savingsCents) })}</span>}
            </div>
          )}
          {!down && (
            <ul style={{ margin: "6px 0 0", padding: 0, listStyle: "none", fontSize: 13 }}>
              {a.reasons.map((r) => (
                <li key={r} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <TriangleAlert size={13} aria-hidden color="var(--c-am)" /> {t(`costs.advice.reason.${r}`)}
                </li>
              ))}
            </ul>
          )}
          {!down && (
            <div style={{ fontSize: 13, marginTop: 6 }}>
              {target ? (
                <>
                  <strong>{t("costs.advice.growTo", { plan: target.label })}</strong>
                  {a.savingsCents !== null && a.savingsCents < 0 && <span style={{ color: "var(--c-tx3)" }}> · {t("costs.advice.costsMore", { amount: money(a.savingsCents) })}</span>}
                </>
              ) : (
                <span style={{ color: "var(--c-tx3)" }}>{t("costs.advice.growNone")}</span>
              )}
            </div>
          )}
          {a.usage && <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "6px 0 0" }}>{t("costs.advice.usage", { cpu: pct(a.usage.cpuP95Pct), mem: pct(a.usage.memP95Pct) })}</p>}
          <p style={{ fontSize: 11, color: "var(--c-tx3)", margin: "4px 0 0" }}>{t(`costs.advice.priceBasis.${a.priceBasis}`, { date: snapshotDate })}</p>
          {a.diskBlocked && <p style={{ fontSize: 12, color: "var(--c-am)", margin: "6px 0 0" }}>{t("costs.advice.diskBlocked")}</p>}
          {a.rescaleBlocked === "active" && !showMove && <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "6px 0 0" }}>{t("costs.advice.running")}</p>}
          {a.rescaleBlocked === "local_hub" && <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "6px 0 0" }}>{t("costs.advice.hubBox")}</p>}
        </div>
        {target && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            {a.rescale === "api" && canManage && !a.rescaleBlocked && !showMove && (
              <Btn onClick={() => setDialog(true)}>{t("costs.advice.resize")}</Btn>
            )}
            <Btn variant="ghost" icon={guideOpen ? ChevronDown : ChevronRight} onClick={() => setGuideOpen((v) => !v)} aria-expanded={guideOpen}>
              {guideOpen ? t("costs.advice.guideHide") : t("costs.advice.guide")}
            </Btn>
          </div>
        )}
      </div>

      {showMove && move && <RescaleProgress move={move} serverName={a.name} planLabel={target?.label ?? move.toPlan} />}
      {guideOpen && target && <GuideSteps name={a.name} provider={a.provider} providerLabel={provider} planLabel={target.label} />}
      {dialog && target && <RescaleDialog advice={a} onClose={() => setDialog(false)} />}
    </Card>
  );
}

function GuideSteps({ name, provider, providerLabel, planLabel }: { name: string; provider: string | null; providerLabel: string; planLabel: string }) {
  const t = useT();
  const key = guideKey(provider);
  const vars = { name, plan: planLabel };
  return (
    <div style={{ marginTop: 12, borderTop: "1px solid var(--c-bd)", paddingTop: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>{providerLabel ? t("costs.guide.title", { name, provider: providerLabel }) : t("costs.guide.titleGeneric", { name })}</div>
      <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13, display: "flex", flexDirection: "column", gap: 4 }}>
        {(["s1", "s2", "s3", "s4"] as const).map((s) => (
          <li key={s}>{t(`costs.guide.${key}.${s}`, vars)}</li>
        ))}
      </ol>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "8px 0 0" }}>{t("costs.guide.downtime")}</p>
    </div>
  );
}

function RescaleProgress({ move, serverName, planLabel }: { move: RescaleView; serverName: string; planLabel: string }) {
  const t = useT();
  const qc = useQueryClient();
  const seen = useRef<string>(move.phase);
  // When the move ends, the price and the advice are different: refresh both once.
  useEffect(() => {
    if (seen.current !== move.phase && (move.phase === "DONE" || move.phase === "FAILED")) {
      qc.invalidateQueries({ queryKey: ["costs"] });
      qc.invalidateQueries({ queryKey: ["costs-advice"] });
    }
    seen.current = move.phase;
  }, [move.phase, qc]);
  const step = rescaleStep(move.phase);
  const failed = move.phase === "FAILED";
  return (
    <div style={{ marginTop: 12, borderTop: "1px solid var(--c-bd)", paddingTop: 12 }} role="status" aria-live="polite">
      <ol aria-label={t("costs.rescale.progress")} style={{ display: "flex", gap: 6, flexWrap: "wrap", listStyle: "none", margin: 0, padding: 0 }}>
        {(["SHUTTING_DOWN", "RESIZING", "POWERING_ON", "DONE"] as const).map((p, i) => (
          <li key={p}>
            <Badge tone={failed ? "muted" : i < step || move.phase === "DONE" ? "ok" : i === step ? "lapis" : "muted"}>{t(`costs.rescale.phase.${p}`)}</Badge>
          </li>
        ))}
      </ol>
      {move.phase === "DONE" && <p style={{ fontSize: 13, margin: "8px 0 0" }}>{t("costs.rescale.doneLine", { name: serverName, plan: planLabel })}</p>}
      {failed && (
        <div role="alert" style={{ fontSize: 13, color: "var(--c-r)", margin: "8px 0 0" }}>
          {t("costs.rescale.failedLine", { error: move.error ?? "" })}
          <div style={{ color: "var(--c-tx3)", fontSize: 12, marginTop: 2 }}>{t("costs.rescale.failedHint")}</div>
        </div>
      )}
    </div>
  );
}

function RescaleDialog({ advice: a, onClose }: { advice: ServerAdvice; onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const [typed, setTyped] = useState("");
  const [grow, setGrow] = useState(false);
  const target = a.target!;
  const start = useMutation({
    mutationFn: () => api.startRescale(a.serverId, { planSlug: target.slug, confirmName: typed, ...(grow ? { upgradeDisk: true } : {}) }),
    onSuccess: () => {
      toast(t("costs.rescale.started"), "success");
      qc.invalidateQueries({ queryKey: ["costs-rescale", a.serverId] });
      onClose();
    },
  });
  return (
    <Modal onClose={onClose} labelledBy="rescale-title" closeOnBackdrop={false}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (typed === a.name) start.mutate();
        }}
      >
        <h3 id="rescale-title" style={{ fontSize: 15, margin: "0 0 10px" }}>
          {t("costs.rescale.title", { name: a.name, plan: target.label })}
        </h3>
        <p style={{ fontSize: 13, color: "var(--c-tx2)", margin: "0 0 10px" }}>{grow ? t("costs.rescale.bodyDisk") : t("costs.rescale.body")}</p>
        <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>{t("costs.rescale.token")}</p>
        {a.upgradeDisk && (
          <div style={{ marginBottom: 12 }}>
            <Checkbox checked={grow} onChange={setGrow} label={t("costs.advice.growDisk")} />
          </div>
        )}
        <TypedConfirmField id="rescale-confirm" expected={a.name} value={typed} onChange={setTyped} label={t("costs.rescale.type")} />
        {start.isError && (
          <div role="alert" style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>
            {(start.error as Error).message}
          </div>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16, flexWrap: "wrap" }}>
          <Btn variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Btn>
          <Btn type="submit" variant="danger" loading={start.isPending} disabled={typed !== a.name}>
            {t("costs.rescale.confirm")}
          </Btn>
        </div>
      </form>
    </Modal>
  );
}
