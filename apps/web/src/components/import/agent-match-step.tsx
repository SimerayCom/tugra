"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useMutation } from "@tanstack/react-query";
import { api, ApiError } from "../../lib/api";
import { useT } from "../../i18n/provider";
import { applyAnswer, canAnswer, canSayNotSame, candidateServers, matchRows, standingConsent, suggestedRows, unsureCount, type MatchRow } from "../../lib/coolify-agent";
import type { TeamScope } from "../../lib/import-team";
import type { ImportPlan, ServerView } from "../../lib/types";
import { Badge, Btn, SectionCard } from "../ui";
import { Select } from "../form";
import { useToast } from "../toast";
import { useConfirm } from "../confirm";
import { AgentConsentCard } from "./agent-consent";
import { TeamFilterToggle } from "./team-filter-toggle";
import { HostVerify } from "./host-verify";

type T = ReturnType<typeof useT>;

const TONE: Record<MatchRow["kind"], "ok" | "lapis" | "warn" | "muted"> = { certain: "ok", probable: "lapis", weak: "warn", none: "muted" };

function errorText(t: T, e: unknown): string {
  if (e instanceof ApiError) {
    const key = `hostMatch.error.${e.code ?? ""}`;
    const text = t(key);
    if (e.code && text !== key) return text;
    if (e.status === 403) return t("hostMatch.error.forbidden");
    if (e.status === 400 || e.status === 404) return t("hostMatch.error.expired");
  }
  return t("hostMatch.error.generic");
}

/** One source server: how sure the hub is, why (plainly), and what the owner can say about it. */
function HostCard({
  row,
  servers,
  sessionId,
  onAnswered,
  onOptimistic,
  onRollback,
  disabled,
}: {
  row: MatchRow;
  servers: ServerView[];
  sessionId: string;
  onAnswered: () => void;
  /** The owner's answer shows on the row at once, before the hub's next plan says the same. */
  onOptimistic: (ref: string, answer: { serverId: string | null; name: string | null }) => void;
  /** The hub refused it: put the row back as it was. */
  onRollback: (ref: string) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const toast = useToast();
  const options = candidateServers(servers, row);
  const [pick, setPick] = useState(row.tugraServerId ?? "");
  const answer = useMutation({
    mutationFn: (v: { serverId: string | null; reset?: boolean }) => api.importHostLink(sessionId, { coolifyServerUuid: row.ref, serverId: v.serverId, ...(v.reset ? { reset: true } : {}) }),
    onMutate: (v) => {
      if (!v.reset) onOptimistic(row.ref, { serverId: v.serverId, name: v.serverId ? options.find((o) => o.id === v.serverId)?.name ?? null : null });
    },
    onSuccess: onAnswered,
    onError: (e) => {
      onRollback(row.ref);
      toast(errorText(t, e), "error");
    },
  });
  return (
    <li style={{ borderTop: "1px solid var(--c-bd)", padding: "12px 0", display: "grid", gap: 8 }} data-testid={`match-${row.ref}`}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontWeight: 600, fontSize: 14, color: "var(--c-tx)", flex: "1 1 140px", overflowWrap: "anywhere" }}>{row.name}</span>
        <Badge tone={TONE[row.kind]}>{t(`hostMatch.status.${row.controlPlane ? "certain" : row.status}`)}</Badge>
        {row.controlPlane && <Badge tone="muted">{t("hostMatch.table.coolifyHost")}</Badge>}
        {row.answeredByOwner && <Badge tone="gold">{t("hostMatch.linkedBy.user")}</Badge>}
      </div>

      {row.controlPlane ? (
        <p style={{ margin: 0, fontSize: 12, color: "var(--c-tx3)", lineHeight: 1.5 }}>
          {row.tugraName ? t("hostMatch.table.hostItselfNamed", { name: row.tugraName }) : t("hostMatch.table.hostItself")}
        </p>
      ) : (
        <p style={{ margin: 0, fontSize: 13, color: "var(--c-tx2)", lineHeight: 1.5 }}>
          {row.tugraName ? t("hostMatch.table.matchedTo", { name: row.tugraName }) : t("hostMatch.table.noneYet")}
          {row.tugraName && <span style={{ color: "var(--c-tx3)" }}> · {t("hostMatch.table.agent", { state: t(row.agentOnline ? "hostMatch.table.agentOnline" : "hostMatch.table.agentOffline") })}</span>}
        </p>
      )}

      {!row.controlPlane && (
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--c-tx3)", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 4 }}>{t("hostMatch.table.evidenceTitle")}</div>
          {row.evidence.length === 0 ? (
            <p style={{ margin: 0, fontSize: 12, color: "var(--c-tx3)" }}>{t("hostMatch.table.noEvidence")}</p>
          ) : (
            <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 3 }}>
              {row.evidence.map((e) => (
                <li key={e.kind} style={{ fontSize: 12, color: e.equal ? "var(--c-tx2)" : "var(--c-r)", display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <span>{t(e.equal ? `hostMatch.evidence.${e.kind}` : `hostMatch.differs.${e.kind}`)}</span>
                  <span style={{ color: "var(--c-tx3)" }}>({t(`hostMatch.strength.${e.strength}`)})</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {canAnswer(row) && (
        <div style={{ display: "grid", gap: 8 }}>
          {row.identityConflict && <p role="status" style={{ margin: 0, fontSize: 12, color: "var(--c-r)", lineHeight: 1.5 }}>{t("hostMatch.answer.conflict")}</p>}
          <label htmlFor={`pick-${row.ref}`} style={{ fontSize: 12, fontWeight: 600, color: "var(--c-tx2)" }}>{t("hostMatch.answer.pick")}</label>
          <Select
            id={`pick-${row.ref}`}
            value={pick}
            onChange={setPick}
            options={options.map((o) => ({ value: o.id, label: o.name }))}
            style={{ maxWidth: 360 }}
          />
          <p style={{ margin: 0, fontSize: 11, color: "var(--c-tx3)", lineHeight: 1.5 }}>{t("hostMatch.answer.sameHelp")}</p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Btn onClick={() => answer.mutate({ serverId: pick })} disabled={!pick || row.identityConflict || disabled} loading={answer.isPending}>{t("hostMatch.answer.same")}</Btn>
            {canSayNotSame(row) && <Btn variant="ghost" onClick={() => answer.mutate({ serverId: null })} disabled={answer.isPending || disabled}>{t("hostMatch.answer.notSame")}</Btn>}
            {row.answeredByOwner && <Btn variant="ghost" onClick={() => answer.mutate({ serverId: null, reset: true })} disabled={answer.isPending || disabled}>{t("hostMatch.answer.undo")}</Btn>}
          </div>
        </div>
      )}
    </li>
  );
}

/**
 * The step after an agent read: which Tugra server is the same machine as each Coolify server, with the evidence in plain words
 * (what proves it, what only suggests it, what never decides) and the owner's own answer when the hub is not sure. The consent for
 * secret values is asked here too when it does not stand yet, because the next steps need it. Nothing here shows an address.
 */
export function AgentMatchStep({
  plan,
  sessionId,
  servers,
  teamId,
  coolifyServer,
  onContinue,
  onRecheck,
  onStartOver,
  rechecking,
  teamScope = null,
  showAllTeams = false,
  onShowAllTeams,
  teamView = null,
  onTeamView,
  onChangeTeamMap,
}: {
  plan: ImportPlan;
  sessionId: string;
  servers: ServerView[];
  teamId: string;
  /** The Tugra server whose agent reads Coolify (its name is what the owner types to consent). */
  coolifyServer: { id: string; name: string } | null;
  onContinue: () => void;
  onRecheck: () => void;
  onStartOver: () => void;
  rechecking?: boolean;
  /** The Coolify team the owner picked on the connect screen (several teams): its servers are listed, the rest sit behind a toggle. */
  teamScope?: TeamScope | null;
  showAllTeams?: boolean;
  onShowAllTeams?: (showAll: boolean) => void;
  /** The one mapped Coolify team in view (null = all the mapped ones), and the way to change it or the mapping. */
  teamView?: string | null;
  onTeamView?: (ref: string | null) => void;
  onChangeTeamMap?: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const [overrides, setOverrides] = useState<Record<string, { serverId: string | null; name: string | null }>>({});
  const [bulkBusy, setBulkBusy] = useState(false);
  // the next plan carries the owner's answers: from then on the rows come from it
  useEffect(() => setOverrides({}), [plan]);
  // with a saved team mapping the rows are always the mapped teams': "show all teams" never opens a team that was left out
  const mapped = plan.preflight?.teamMap !== undefined;
  const filter = teamScope && (!showAllTeams || mapped) ? teamScope : null;
  const rows = useMemo(
    () =>
      matchRows(plan)
        .filter((r) => !filter || filter.hosts.has(r.ref))
        .map((r) => {
          const o = overrides[r.ref];
          return o ? applyAnswer(r, { ...o, agentOnline: servers.find((s) => s.id === o.serverId)?.status === "ONLINE" }) : r;
        }),
    [plan, filter, overrides, servers],
  );
  const unsure = unsureCount(rows);
  const suggested = suggestedRows(rows);
  const setOverride = (ref: string, a: { serverId: string | null; name: string | null }) => setOverrides((o) => ({ ...o, [ref]: a }));
  const dropOverride = (ref: string) =>
    setOverrides((o) => {
      const { [ref]: _gone, ...rest } = o;
      return rest;
    });

  // One answer at a time: the hub keeps the answers on the session as one record, so parallel writes could lose each other.
  const confirmAll = async () => {
    const batch = suggested;
    const lines = batch.map((r) => t("hostMatch.bulk.line", { coolify: r.name, tugra: r.tugraName ?? "" }));
    const ok = await confirm({ title: t("hostMatch.bulk.title", { count: batch.length }), body: `${t("hostMatch.bulk.body")}\n${lines.join("\n")}`, confirmLabel: t("hostMatch.bulk.confirm", { count: batch.length }) });
    if (!ok) return;
    setBulkBusy(true);
    let failed = 0;
    let lastError: unknown = null;
    for (const r of batch) {
      setOverride(r.ref, { serverId: r.tugraServerId, name: r.tugraName });
      try {
        await api.importHostLink(sessionId, { coolifyServerUuid: r.ref, serverId: r.tugraServerId });
      } catch (e) {
        failed += 1;
        lastError = e;
        dropOverride(r.ref);
      }
    }
    setBulkBusy(false);
    if (failed > 0) toast(`${t("hostMatch.bulk.failed", { failed, total: batch.length })} ${errorText(t, lastError)}`, "error");
    if (failed < batch.length) onRecheck();
  };
  const standing = standingConsent(plan);
  const [skippedConsent, setSkippedConsent] = useState(false);
  return (
    <div style={{ display: "grid", gap: 16, maxWidth: 720 }}>
      <SectionCard title={t("hostMatch.title")} desc={t("hostMatch.table.hint")}>
        <TeamFilterToggle scope={teamScope} showAll={showAllTeams && !mapped} hidden={mapped ? 0 : filter?.hiddenHosts ?? 0} onChange={(v) => onShowAllTeams?.(v)} view={teamView} onView={onTeamView} onChangeMap={onChangeTeamMap} />
        <HostVerify serverId={coolifyServer?.id ?? null} rows={rows} onDone={onRecheck} />
        <p role="status" style={{ margin: "0 0 4px", fontSize: 12, color: unsure ? "var(--c-am)" : "var(--c-g)" }}>
          {unsure ? t("hostMatch.table.sureCount", { n: unsure }) : t("hostMatch.table.allSure")}
        </p>
        {suggested.length > 0 && (
          <div style={{ display: "grid", gap: 4, margin: "8px 0" }}>
            <div>
              <Btn onClick={() => void confirmAll()} loading={bulkBusy} disabled={rechecking} style={{ minHeight: 44 }}>{t("hostMatch.bulk.button", { count: suggested.length })}</Btn>
            </div>
            <p style={{ margin: 0, fontSize: 11, color: "var(--c-tx3)", lineHeight: 1.5 }}>{t("hostMatch.bulk.hint")}</p>
          </div>
        )}
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }} aria-label={t("hostMatch.table.title")}>
          {rows.map((r) => (
            <HostCard key={r.ref} row={r} servers={servers} sessionId={sessionId} onAnswered={onRecheck} onOptimistic={setOverride} onRollback={dropOverride} disabled={bulkBusy} />
          ))}
        </ul>
        <p style={{ margin: "12px 0 0", fontSize: 12, color: "var(--c-tx3)", lineHeight: 1.5 }}>
          {t("hostMatch.installHint")}{" "}
          {/* a new tab, so the wizard (its session, team mapping and answers) stays where it is; the page installs per the session's team mapping */}
          <Link href={`/import/coolify-host?session=${encodeURIComponent(sessionId)}`} target="_blank" rel="noopener noreferrer" style={{ color: "var(--c-lapis)" }}>{t("coolifyTakeover.title")}</Link>
        </p>
      </SectionCard>

      {coolifyServer && !standing && !skippedConsent && (
        <AgentConsentCard serverId={coolifyServer.id} serverName={coolifyServer.name} teamId={teamId} sessionId={sessionId} secretCounts={plan.preflight?.agentRead?.secretCounts} standing={standing} onChanged={onRecheck} onSkip={() => setSkippedConsent(true)} />
      )}
      {coolifyServer && !standing && skippedConsent && (
        <SectionCard>
          <p role="status" style={{ margin: "0 0 10px", fontSize: 13, color: "var(--c-am)", lineHeight: 1.5 }}>{t("coolifySecrets.consent.skipped")}</p>
          <Btn variant="ghost" onClick={() => setSkippedConsent(false)}>{t("coolifySecrets.consent.allowNow")}</Btn>
        </SectionCard>
      )}
      {coolifyServer && standing && <AgentConsentCard serverId={coolifyServer.id} serverName={coolifyServer.name} teamId={teamId} sessionId={sessionId} secretCounts={plan.preflight?.agentRead?.secretCounts} standing={standing} onChanged={onRecheck} />}

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <Btn onClick={onContinue} disabled={rechecking}>{unsure ? t("hostMatch.continueUnsure", { n: unsure }) : t("hostMatch.continue")}</Btn>
        <Btn variant="ghost" onClick={onStartOver}>{t("import.startOver")}</Btn>
      </div>
    </div>
  );
}
