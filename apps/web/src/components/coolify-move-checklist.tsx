"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import type { MoveOffServerRow, MoveOffStatusView, MoveOffStep, MoveOffStepProgress } from "@tugra/shared";
import { api, ApiError } from "../lib/api";
import { useT } from "../i18n/provider";
import { useTeamContext, useTeamScope } from "./team-scope";
import { GRANT_TONE, STAGE_TONE, STEP_LETTER, connectHref, coolifyRows, currentStep, readyToShutDown, rowAction, sortRows, stepOf } from "../lib/coolify-move";
import { formatDateTime } from "../lib/format-time";
import { relativeTime } from "../lib/fleet";
import { Select } from "./form";
import { Badge, LinkBtn, SectionCard, Spinner } from "./ui";
import { CampaignReportList } from "./campaign-report-list";

type T = ReturnType<typeof useT>;

const li: React.CSSProperties = { borderTop: "1px solid var(--c-bd)", padding: "8px 0", display: "flex", gap: "4px 10px", flexWrap: "wrap", alignItems: "center", minWidth: 0, fontSize: 13 };
const dim: React.CSSProperties = { fontSize: 12.5, color: "var(--c-tx2)", lineHeight: 1.5, margin: 0 };

function StepCard({ step, progress, current, children }: { step: MoveOffStep; progress: MoveOffStepProgress; current: boolean; children: React.ReactNode }) {
  const t = useT();
  const optional = step === "consolidate" && progress.total === 0;
  return (
    <div data-testid={`step-${step}`} data-current={current ? "true" : "false"}>
      <SectionCard
        title={t(`coolifyMove.step.${step}.title`)}
        desc={t(`coolifyMove.step.${step}.desc`)}
        right={
          <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            {current && <Badge tone="gold">{t("coolifyMove.step.current")}</Badge>}
            <Badge tone={progress.complete ? "ok" : optional ? "muted" : "lapis"}>
              {optional ? t("coolifyMove.step.optional") : progress.complete ? t("coolifyMove.step.complete") : t("coolifyMove.step.progress", { done: progress.done, total: progress.total })}
            </Badge>
          </span>
        }
      >
        {children}
      </SectionCard>
    </div>
  );
}

function RowAction({ row, step, t }: { row: MoveOffServerRow; step: "takeover" | "cleanup"; t: T }) {
  // Step B only starts once a server is taken over; before that its action is step A's.
  if (step === "cleanup" && (row.stage === "agent" || row.stage === "takeover")) return <span style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("coolifyMove.step.takeover.title")}</span>;
  if (step === "takeover" && (row.stage === "cleanup" || row.stage === "done")) return <Badge tone="ok">{t("coolifyMove.step.complete")}</Badge>;
  const a = rowAction(row);
  if (!a) return null;
  return (
    <Link href={a.href} className="tg-link" style={{ fontSize: 12.5, minHeight: 44, display: "inline-flex", alignItems: "center" }}>
      {t(a.labelKey)}
    </Link>
  );
}

function ServerList({ rows, step }: { rows: MoveOffServerRow[]; step: "takeover" | "cleanup" }) {
  const t = useT();
  if (rows.length === 0) return <p style={dim}>{t("coolifyMove.noServers")}</p>;
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {rows.map((r) => (
        <li key={r.serverId} style={li} data-testid={`row-${step}-${r.serverId}`}>
          <Link href={`/servers/${encodeURIComponent(r.serverId)}`} className="tg-link" style={{ fontWeight: 600, flex: "1 1 140px", minWidth: 0, overflowWrap: "anywhere" }}>
            {r.name}
          </Link>
          <Badge tone={r.agentOnline ? "ok" : "danger"}>{r.agentOnline ? t("coolifyMove.line.agent.online") : t("coolifyMove.line.agent.offline")}</Badge>
          {step === "takeover" ? (
            <Badge tone={r.takeover === "none" ? "muted" : r.takeover === "FAILED" ? "danger" : r.takeover === "VERIFIED" ? "ok" : "lapis"}>
              {r.takeover === "none" ? t("coolifyMove.line.takeover.none") : t(`coolifyInPlace.status.${r.takeover}`)}
            </Badge>
          ) : (
            <Badge tone={r.cleanup === "none" ? "muted" : r.cleanup === "CLEANED" ? "ok" : r.cleanup === "FAILED" ? "danger" : "warn"}>
              {r.cleanup === "none" ? t("coolifyMove.line.cleanup.none") : t(`coolifyCleanup.status.${r.cleanup}`)}
            </Badge>
          )}
          <span style={{ fontSize: 12, color: "var(--c-tx3)", flexBasis: "100%" }}>{t(`coolifyMove.stage.${r.stage}`)}</span>
          <RowAction row={r} step={step} t={t} />
        </li>
      ))}
    </ul>
  );
}

function Prelude({ v }: { v: MoveOffStatusView }) {
  const t = useT();
  const hub = v.hub;
  return (
    <SectionCard title={t("coolifyMove.prelude.title")} desc={t("coolifyMove.prelude.desc")}>
      {!hub ? (
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <p style={{ ...dim, flex: "1 1 200px" }}>{t("coolifyMove.prelude.none")}</p>
          <LinkBtn href="/import/coolify-host">{t("coolifyMove.prelude.connect")}</LinkBtn>
        </div>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }} data-testid="prelude-lines">
          <li style={li}>
            <span style={{ fontWeight: 600, flex: "1 1 150px" }}>{t("coolifyMove.line.read.label")}</span>
            <Badge tone={hub.readAt ? "ok" : "warn"}>
              {hub.readAt ? (hub.knownServers !== null ? t("coolifyMove.line.read.done", { when: relativeTime(hub.readAt, t), servers: hub.knownServers }) : t("coolifyMove.line.read.doneNoCount", { when: relativeTime(hub.readAt, t) })) : t("coolifyMove.line.read.never")}
            </Badge>
          </li>
          <li style={li}>
            <span style={{ fontWeight: 600, flex: "1 1 150px" }}>{t("coolifyMove.line.agents.label")}</span>
            <Badge tone={hub.ssh ? (hub.ssh.failed > 0 ? "warn" : hub.ssh.finished ? "ok" : "lapis") : "muted"}>
              {hub.ssh ? t("coolifyMove.line.agents.some", { online: hub.ssh.online, total: hub.ssh.total, failed: hub.ssh.failed, pending: hub.ssh.pending }) : t("coolifyMove.line.agents.none")}
            </Badge>
          </li>
          <li style={li}>
            <span style={{ fontWeight: 600, flex: "1 1 150px" }}>{t("coolifyMove.line.secrets.label")}</span>
            <Badge tone={GRANT_TONE[hub.secrets]}>
              {hub.secrets === "active" && hub.secretsExpiresAt ? t("coolifyMove.line.secrets.active", { when: formatDateTime(hub.secretsExpiresAt) }) : t(`coolifyMove.line.secrets.${hub.secrets}`)}
            </Badge>
          </li>
          <li style={li}>
            <Link href={connectHref(hub.serverId)} className="tg-link" style={{ fontSize: 12.5, minHeight: 44, display: "inline-flex", alignItems: "center" }}>
              {t("coolifyMove.prelude.openHost")}
            </Link>
          </li>
        </ul>
      )}
    </SectionCard>
  );
}

/** The four steps with what is done, per server. Pure view of one status. */
export function MoveOffBody({ v, teamId }: { v: MoveOffStatusView; teamId: string }) {
  const t = useT();
  const movers = sortRows(coolifyRows(v.servers));
  const others = v.servers.filter((s) => !s.coolify && !s.isCoolifyHub);
  const cur = currentStep(v);
  const cleaned = stepOf(v, "cleanup");
  const ready = readyToShutDown(v);
  const left = movers.filter((r) => r.stage !== "done").length;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {cleaned.total > 0 && <p data-testid="overall" style={{ ...dim, fontSize: 13 }}>{t("coolifyMove.overall", { done: cleaned.done, total: cleaned.total })}</p>}
      <Prelude v={v} />
      {movers.length === 0 && <p style={dim}>{t("coolifyMove.noServers")}</p>}
      <StepCard step="takeover" progress={stepOf(v, "takeover")} current={cur === "takeover"}>
        <ServerList rows={movers} step="takeover" />
      </StepCard>
      <StepCard step="cleanup" progress={cleaned} current={cur === "cleanup"}>
        <ServerList rows={movers} step="cleanup" />
      </StepCard>
      <StepCard step="consolidate" progress={stepOf(v, "consolidate")} current={false}>
        <p style={dim}>{v.projectMoves.total === 0 ? t("coolifyMove.consolidate.none") : t("coolifyMove.consolidate.counts", { total: v.projectMoves.total, completed: v.projectMoves.completed, active: v.projectMoves.active, failed: v.projectMoves.failed })}</p>
        <div style={{ marginTop: 10 }}>
          <LinkBtn href="/projects" variant="ghost">{t("coolifyMove.consolidate.openProjects")}</LinkBtn>
        </div>
      </StepCard>
      <StepCard step="shutdown" progress={stepOf(v, "shutdown")} current={cur === "shutdown"}>
        <p data-testid="shutdown-state" style={dim}>{!v.hub ? t("coolifyMove.shutdown.noHub") : ready ? t("coolifyMove.shutdown.ready") : t("coolifyMove.shutdown.notReady", { count: left })}</p>
        {v.hub && (
          <div style={{ marginTop: 10 }}>
            <LinkBtn href={`/servers/${encodeURIComponent(v.hub.serverId)}`} variant="ghost">{t("coolifyMove.prelude.openHost")}</LinkBtn>
          </div>
        )}
      </StepCard>
      <CampaignReportList teamId={teamId} />
      {others.length > 0 && <p style={{ ...dim, color: "var(--c-tx3)" }}>{t("coolifyMove.others", { count: others.length })}</p>}
    </div>
  );
}

/** `/import/move-off-coolify`: walk the move A to D with every server's progress, read from one status route. */
export function CoolifyMoveChecklist() {
  const t = useT();
  const { teams } = useTeamContext();
  const { teamId: scope } = useTeamScope();
  const eligible = teams.filter((tm) => tm.role === "OWNER" || tm.role === "ADMIN");
  const teamId = eligible.find((tm) => tm.id === scope)?.id ?? eligible[0]?.id ?? "";
  const q = useQuery({ queryKey: ["coolify-move", teamId], queryFn: () => api.coolifyMoveStatus(teamId), enabled: !!teamId, refetchInterval: 10_000 });
  const forbidden = q.error instanceof ApiError && q.error.status === 403;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {eligible.length > 1 && (
        <TeamPick teams={eligible} value={teamId} />
      )}
      {teams.length > 0 && eligible.length === 0 && <p role="alert" style={{ ...dim, color: "var(--c-r)" }}>{t("coolifyMove.error.forbidden")}</p>}
      {q.isLoading && !!teamId && <Spinner />}
      {q.isError && <p role="alert" style={{ ...dim, color: "var(--c-r)" }}>{forbidden ? t("coolifyMove.error.forbidden") : t("coolifyMove.error.generic")}</p>}
      {q.data && <MoveOffBody v={q.data} teamId={teamId} />}
    </div>
  );
}

function TeamPick({ teams, value }: { teams: Array<{ id: string; name: string }>; value: string }) {
  const t = useT();
  const { setTeamId } = useTeamScope();
  return (
    <label style={{ display: "grid", gap: 4, fontSize: 13, maxWidth: 320 }}>
      <span>{t("coolifyMove.team")}</span>
      <Select value={value} onChange={(id) => setTeamId(id)} ariaLabel={t("coolifyMove.team")} options={teams.map((tm) => ({ value: tm.id, label: tm.name }))} />
    </label>
  );
}
