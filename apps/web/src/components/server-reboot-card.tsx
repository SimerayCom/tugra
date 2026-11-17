"use client";

import { useState, type ReactNode } from "react";
import { CalendarClock, Check, Circle, Power, TriangleAlert } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useT } from "../i18n/provider";
import { Badge, Btn, SectionCard, Spinner } from "./ui";
import { Modal } from "./modal";
import { fieldStyle } from "./form";
import { useToast } from "./toast";
import type { RebootContainerVerdict, RebootDomainVerdict, RebootReport, RebootResult, RebootView } from "../lib/types";
import {
  confirmationMatches,
  defaultScheduleValue,
  formatLocal,
  formatUtc,
  fromLocalInputValue,
  rebootPhase,
  rebootPollMs,
  rebootSteps,
  reportProblems,
  scheduleProblem,
  toLocalInputValue,
  REBOOT_MAX_LEAD_MS,
  REBOOT_MIN_LEAD_MS,
  type RebootPhase,
} from "../lib/reboot";

type Tone = "ok" | "warn" | "danger" | "muted";
const RESULT_TONE: Record<RebootResult, Tone> = { ok: "ok", degraded: "warn", failed: "danger", cancelled: "muted" };
const CONTAINER_TONE: Record<RebootContainerVerdict, Tone> = { ok: "ok", missing: "danger", unhealthy: "danger", pending: "warn", skipped: "muted" };
const DOMAIN_TONE: Record<RebootDomainVerdict, Tone> = { ok: "ok", not_answering: "danger", pending: "warn", unverified: "muted" };

export const REBOOT_QUERY_KEY = (id: string) => ["server-reboot", id] as const;

/**
 * The Reboot card of a server (Maintenance tab): "Reboot now" and "Schedule", a typed-confirmation dialog with an
 * impact preview, the live state of a reboot in progress (scheduled / rebooting / waiting for the agent / verifying)
 * and the last verification report with a result per container and per domain. A reboot is never automatic; the
 * buttons exist only for people who may operate the server.
 */
export function ServerRebootCard({ id, serverName, canWrite }: { id: string; serverName: string; canWrite: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const [dialog, setDialog] = useState<"now" | "schedule" | null>(null);

  const status = useQuery({
    queryKey: REBOOT_QUERY_KEY(id),
    queryFn: () => api.getServerReboot(id),
    // Keep reading while a reboot is live. It keeps going through errors on purpose: the hub that serves this page may
    // be the very server that is rebooting, and the page must pick up on its own when it is back.
    refetchInterval: (q) => (q.state.data?.active ? rebootPollMs.live : false),
  });
  const active = status.data?.active ?? null;
  const last = status.data?.last ?? null;

  const cancel = useMutation({
    mutationFn: () => api.cancelServerReboot(id),
    onSuccess: () => {
      toast(t("reboot.cancelled"), "info");
      qc.invalidateQueries({ queryKey: REBOOT_QUERY_KEY(id) });
    },
  });

  return (
    <SectionCard id="server-reboot" title={t("reboot.title")} desc={t("reboot.desc")} style={{ marginTop: 20 }}>
      {active ? (
        <LiveReboot reboot={active} unreachable={status.isError} canWrite={canWrite} cancelling={cancel.isPending} onCancel={() => cancel.mutate()} />
      ) : canWrite ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <Btn variant="dangerGhost" icon={Power} onClick={() => setDialog("now")}>{t("reboot.now")}</Btn>
          <Btn variant="ghost" icon={CalendarClock} onClick={() => setDialog("schedule")}>{t("reboot.schedule")}</Btn>
        </div>
      ) : (
        <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: 0 }}>{t("reboot.viewOnly")}</p>
      )}
      {cancel.isError && <div role="alert" style={{ fontSize: 12, color: "var(--c-r)", marginTop: 8 }}>{(cancel.error as Error).message}</div>}
      {last && <LastReboot reboot={last} />}
      {dialog && (
        <RebootDialog
          id={id}
          serverName={serverName}
          mode={dialog}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            qc.invalidateQueries({ queryKey: REBOOT_QUERY_KEY(id) });
          }}
        />
      )}
    </SectionCard>
  );
}

// ── confirmation dialog ────────────────────────────────────────────────────────────────────────────────────────────

function RebootDialog({ id, serverName, mode, onClose, onDone }: { id: string; serverName: string; mode: "now" | "schedule"; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const [typed, setTyped] = useState("");
  const [when, setWhen] = useState(() => defaultScheduleValue(Date.now()));
  const preview = useQuery({ queryKey: ["server-reboot-preview", id], queryFn: () => api.getServerRebootPreview(id), staleTime: 0, gcTime: 0 });
  const send = useMutation({
    mutationFn: () => {
      if (mode === "now") return api.requestServerReboot(id, { mode: "now", confirmName: typed });
      const at = fromLocalInputValue(when);
      if (!at) throw new Error(t("reboot.scheduleError.invalid"));
      return api.requestServerReboot(id, { mode: "scheduled", at, confirmName: typed });
    },
    onSuccess: onDone,
  });

  const problem = mode === "schedule" ? scheduleProblem(when, Date.now()) : null;
  const iso = mode === "schedule" ? fromLocalInputValue(when) : null;
  const agentOffline = preview.data ? !preview.data.agentOnline : false;
  const canSend = confirmationMatches(typed, serverName) && !problem && !send.isPending && !agentOffline;
  const now = Date.now();

  return (
    <Modal onClose={onClose} labelledBy="reboot-dlg-title" closeOnBackdrop={false}>
      <h3 id="reboot-dlg-title" style={{ margin: "0 0 10px", fontSize: 15 }}>
        {mode === "now" ? t("reboot.dialog.titleNow", { server: serverName }) : t("reboot.dialog.titleSchedule", { server: serverName })}
      </h3>

      {mode === "schedule" && (
        <label style={{ display: "block", marginBottom: 12 }}>
          <span style={{ display: "block", fontSize: 12, color: "var(--c-tx2)", marginBottom: 6 }}>{t("reboot.dialog.when")}</span>
          <input
            type="datetime-local"
            value={when}
            min={toLocalInputValue(new Date(now + REBOOT_MIN_LEAD_MS))}
            max={toLocalInputValue(new Date(now + REBOOT_MAX_LEAD_MS))}
            onChange={(e) => setWhen(e.target.value)}
            aria-label={t("reboot.dialog.when")}
            aria-invalid={problem ? true : undefined}
            style={fieldStyle}
          />
          {problem ? (
            <span role="alert" style={{ display: "block", fontSize: 12, color: "var(--c-r)", marginTop: 6 }}>{t(`reboot.scheduleError.${problem}`)}</span>
          ) : (
            iso && (
              <span style={{ display: "block", fontSize: 12, color: "var(--c-tx3)", marginTop: 6, lineHeight: 1.5 }}>
                {t("reboot.dialog.scheduleLocal", { local: formatLocal(iso) })}
                <br />
                {t("reboot.dialog.scheduleUtc", { utc: formatUtc(iso) })}
              </span>
            )
          )}
          <span style={{ display: "block", fontSize: 11, color: "var(--c-tx3)", marginTop: 4 }}>{t("reboot.dialog.scheduleRange")}</span>
        </label>
      )}

      <div data-testid="reboot-impact" style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: "10px 12px", marginBottom: 12, fontSize: 13, color: "var(--c-tx2)", lineHeight: 1.5 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--c-tx3)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>{t("reboot.dialog.impactTitle")}</div>
        {preview.isLoading ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><Spinner /> {t("reboot.dialog.impactLoading")}</span>
        ) : preview.data ? (
          <>
            <div>{t("reboot.dialog.impact", { containers: preview.data.containers, domains: preview.data.domains })}</div>
            <div style={{ color: "var(--c-tx3)", marginTop: 4 }}>{t("reboot.dialog.impactAfter")}</div>
            {preview.data.hostsHub && <Warning>{t("reboot.dialog.hub")}</Warning>}
            {agentOffline && <Warning>{t("reboot.dialog.agentOffline")}</Warning>}
          </>
        ) : (
          <span style={{ color: "var(--c-am)" }}>{t("reboot.dialog.impactFailed")}</span>
        )}
      </div>

      <label style={{ display: "block", marginBottom: 14 }}>
        <span style={{ display: "block", fontSize: 12, color: "var(--c-tx2)", marginBottom: 6, lineHeight: 1.5 }}>{t("reboot.dialog.typeToConfirm", { name: serverName })}</span>
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && canSend) send.mutate(); }}
          aria-label={t("reboot.dialog.typeToConfirm", { name: serverName })}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          style={fieldStyle}
        />
      </label>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "flex-end" }}>
        <Btn variant="ghost" onClick={onClose} disabled={send.isPending}>{t("reboot.dialog.cancel")}</Btn>
        <Btn variant="danger" onClick={() => send.mutate()} disabled={!canSend} loading={send.isPending}>
          {mode === "now" ? t("reboot.dialog.confirmNow") : t("reboot.dialog.confirmSchedule")}
        </Btn>
      </div>
      {send.isError && <div role="alert" style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(send.error as Error).message}</div>}
    </Modal>
  );
}

function Warning({ children }: { children: ReactNode }) {
  return (
    <div role="note" style={{ display: "flex", alignItems: "flex-start", gap: 6, color: "var(--c-am)", marginTop: 8, fontSize: 12 }}>
      <TriangleAlert size={13} aria-hidden style={{ flexShrink: 0, marginTop: 2 }} />
      <span>{children}</span>
    </div>
  );
}

// ── a reboot in flight ─────────────────────────────────────────────────────────────────────────────────────────────

function LiveReboot({ reboot, unreachable, canWrite, cancelling, onCancel }: { reboot: RebootView; unreachable: boolean; canWrite: boolean; cancelling: boolean; onCancel: () => void }) {
  const t = useT();
  const phase = rebootPhase(reboot.state) as RebootPhase;
  const steps = rebootSteps(reboot);
  const at = steps.indexOf(phase);
  return (
    <div data-testid="reboot-live" data-state={reboot.state} role="status" aria-live="polite">
      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--c-tx)", marginBottom: 4 }}>
        {phase === "scheduled" ? t("reboot.live.headingScheduled") : t("reboot.live.heading")}
      </div>
      {phase === "scheduled" && reboot.scheduledAt && (
        <div style={{ fontSize: 13, color: "var(--c-tx2)", marginBottom: 4 }}>
          {t("reboot.live.scheduledFor", { when: formatLocal(reboot.scheduledAt) })}
          <span style={{ display: "block", fontSize: 11, color: "var(--c-tx3)" }}>{formatUtc(reboot.scheduledAt)}</span>
        </div>
      )}
      <ol style={{ listStyle: "none", margin: "10px 0", padding: 0, display: "flex", flexWrap: "wrap", gap: "6px 14px" }}>
        {steps.map((s, i) => {
          const done = i < at;
          const current = i === at;
          return (
            <li key={s} aria-current={current ? "step" : undefined} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: current ? 700 : 500, color: current ? "var(--c-tx)" : done ? "var(--c-g)" : "var(--c-tx3)" }}>
              {done ? <Check size={13} aria-hidden /> : current && s !== "scheduled" ? <Spinner /> : <Circle size={11} aria-hidden />}
              {t(`reboot.live.step.${s}`)}
            </li>
          );
        })}
      </ol>
      <div style={{ fontSize: 12, color: "var(--c-tx3)", lineHeight: 1.5 }}>{t(`reboot.live.hint.${phase}`)}</div>
      {reboot.snapshot?.hostsHub && phase !== "scheduled" && <Warning>{t("reboot.dialog.hub")}</Warning>}
      {unreachable && <Warning>{t("reboot.live.unreachable")}</Warning>}
      {phase === "scheduled" && canWrite && (
        <div style={{ marginTop: 10 }}>
          <Btn variant="ghost" onClick={onCancel} loading={cancelling}>{cancelling ? t("reboot.cancelling") : t("reboot.cancelScheduled")}</Btn>
        </div>
      )}
    </div>
  );
}

// ── the last verification report ───────────────────────────────────────────────────────────────────────────────────

function LastReboot({ reboot }: { reboot: RebootView }) {
  const t = useT();
  const report = reboot.report;
  const result = reboot.result ?? "failed";
  return (
    <div data-testid="reboot-report" style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--c-bd)" }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: "var(--c-tx3)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{t("reboot.report.title")}</span>
        <Badge tone={RESULT_TONE[result]}>{t(`reboot.report.result.${result}`)}</Badge>
      </div>
      {reboot.verifiedAt && <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 8 }}>{t("reboot.report.when", { when: formatLocal(reboot.verifiedAt) })}</div>}
      {report ? <ReportBody report={report} result={result} /> : null}
    </div>
  );
}

function ReportBody({ report, result }: { report: RebootReport; result: RebootResult }) {
  const t = useT();
  const verified = report.containers.length > 0 || report.domains.length > 0 || result === "ok" || result === "degraded";
  const problems = reportProblems(report);
  return (
    <>
      {report.reason && (
        <div role="alert" style={{ display: "flex", alignItems: "flex-start", gap: 6, fontSize: 13, color: "var(--c-r)", marginBottom: 8 }}>
          <TriangleAlert size={13} aria-hidden style={{ flexShrink: 0, marginTop: 2 }} />
          <span>{t(`reboot.reason.${report.reason}`)}</span>
        </div>
      )}
      {verified && (
        <div style={{ fontSize: 13, color: "var(--c-tx2)", marginBottom: 10 }}>
          {t("reboot.report.summary", { containersOk: report.summary.containersOk, containersTotal: report.summary.containersExpected, domainsOk: report.summary.domainsOk, domainsTotal: report.summary.domainsExpected })}
        </div>
      )}
      {report.docker === "inactive" && <Warning>{t("reboot.report.dockerInactive")}</Warning>}
      {report.rebootRequired === "still_set" && <Warning>{t("reboot.report.rebootRequiredStill")}</Warning>}
      {report.domainsNote === "skipped_no_host_port" && <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 8 }}>{t("reboot.report.domainsSkipped")}</div>}
      {report.domainsNote === "probe_unavailable" && <Warning>{t("reboot.report.probeUnavailable")}</Warning>}

      {report.containers.length > 0 && (
        <ReportList title={t("reboot.report.containers")} testId="reboot-containers" attention={problems.containers.length}>
          {report.containers.map((c) => (
            <li key={c.name} style={rowStyle}>
              <span style={{ minWidth: 0, flex: "1 1 160px", overflowWrap: "anywhere" }}>
                <span style={{ fontWeight: 600, color: "var(--c-tx)" }}>{c.name}</span>
                <span style={{ display: "block", fontSize: 11, color: "var(--c-tx3)" }}>{c.image} · {t("reboot.report.restartPolicy", { policy: c.restartPolicy })}</span>
              </span>
              <Badge tone={CONTAINER_TONE[c.verdict]}>{t(`reboot.verdict.container.${c.verdict}`)}</Badge>
            </li>
          ))}
        </ReportList>
      )}
      {report.domains.length > 0 && (
        <ReportList title={t("reboot.report.domains")} testId="reboot-domains" attention={problems.domains.length}>
          {report.domains.map((d) => (
            <li key={d.host} style={rowStyle}>
              <span style={{ minWidth: 0, flex: "1 1 160px", overflowWrap: "anywhere", fontWeight: 600, color: "var(--c-tx)" }}>
                {d.host}
                {d.status ? <span style={{ fontWeight: 400, color: "var(--c-tx3)" }}> · {d.status}</span> : null}
              </span>
              <Badge tone={DOMAIN_TONE[d.verdict]}>{t(`reboot.verdict.domain.${d.verdict}`)}</Badge>
            </li>
          ))}
        </ReportList>
      )}
    </>
  );
}

const rowStyle = { display: "flex", flexWrap: "wrap" as const, alignItems: "center", justifyContent: "space-between", gap: 8, padding: "7px 0", borderTop: "1px solid var(--c-bd)", fontSize: 13 };

function ReportList({ title, testId, attention, children }: { title: string; testId: string; attention: number; children: ReactNode }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: attention > 0 ? "var(--c-r)" : "var(--c-tx2)", marginBottom: 2 }}>{title}</div>
      <ul data-testid={testId} style={{ listStyle: "none", margin: 0, padding: 0 }}>{children}</ul>
    </div>
  );
}
