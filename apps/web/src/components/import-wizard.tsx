"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useT } from "../i18n/provider";
import { Card, SectionCard, Btn, EmptyState, Spinner } from "./ui";
import { useToast } from "./toast";
import { useConfirm } from "./confirm";
import { CopyBtn } from "./copy-row";
import { ImportReviewStep } from "./import-review-step";
import { ImportScopeStep } from "./import-scope-step";
import type { SourceServerRow } from "../lib/migration-run";
import { scopedPlan, scopeServiceSkips, splitByPlacement, type ImportScope, type ScopeSelection } from "../lib/import-scope";
import { clearImportResume, loadImportResume, saveImportResume } from "../lib/import-resume";
import { IMPORT_PREFILL_KEY } from "../lib/coolify-takeover";
import { focusSelection, focusSubject, lastImportUrl, rememberLastImportUrl, takeImportFocus, type ImportFocus } from "../lib/import-focus";
import { rememberObjectMigrationContext } from "../lib/object-migration-context";
import { CutoverPanel } from "./cutover-panel";
import { planSummary, itemsByKind, riskTone, opProgress, coverageApps, coverageCounts, hasDeferredCoverage, reasonText, ackableItems, buildAcks, runnableAfterAcks, serviceChoicesPayload, volumeCopyCandidates, selectedDbModes, vxCommandsWithFlags } from "../lib/import";
import { ImportVolumeTransfers } from "./import-volume-transfers";
import { EnvBlockers } from "./import/env-blockers";
import { GitLinksPanel, GitRelinkCard, DeployKeyBlock } from "./import/git-links-panel";
import { ImportSettingsPanel } from "./import/settings-panel";
import { ImportServicesPanel } from "./import-services-panel";
import { ConnectionStatus, useConnectionTest } from "./import/connection-test";
import { AgentConnectPanel } from "./import/agent-connect";
import { ResumeNote } from "./import/resume-note";
import { coolifyTeams, teamScope } from "../lib/import-team";
import { TeamMapStep } from "./import/team-map-step";
import { AgentMatchStep } from "./import/agent-match-step";
import { isConsentRequired, needsConsent, needsMatchStep } from "../lib/coolify-agent";
import { AgentConsentGate } from "./import/agent-consent-gate";
import { MoreInfo } from "./help-link";
import { guideUrl } from "../lib/help-links";
import { ImportChecklist } from "./import-checklist";
import { GuidedRunLauncher } from "./migration-run/guided-run-launcher";
import type { Team, ImportApplyExtras, ImportPlan, ImportPlanItem, ImportRiskLevel, ImportOperation, ImportOpTask, ImportRemoteKind, ImportServiceChoice, ImportTaskStatus, MintedMigrationToken, ImportRemapPlan, ImportRemapResult, VxCommands } from "../lib/types";

const toneColor: Record<"danger" | "warning" | "info", string> = {
  danger: "var(--c-r)",
  warning: "var(--c-am)",
  info: "var(--c-tx3)",
};

function statusColor(s: ImportTaskStatus): string {
  if (s === "DONE") return "var(--c-g)";
  if (s === "FAILED" || s === "FAILED_VERIFY") return "var(--c-r)";
  if (s === "SKIPPED" || s === "ROLLED_BACK" || s === "CANCELLED") return "var(--c-tx3)";
  return "var(--c-am)"; // PENDING | RUNNING | AWAITING_CUTOVER
}

/** Per-source copy, addressed through literal keys (so static key-usage checks keep working). */
const SRC = {
  coolify: { title: "import.sourceCoolify", hint: "import.sourceCoolifyHint", url: "import.baseUrl", ph: "import.baseUrlPlaceholder", tok: "import.token", tokHint: "import.tokenHint", fail: "import.connectFailed", name: "import.sourceNameCoolify", option: "import.sourceCoolifyOption" },
  dokploy: { title: "import.sourceDokploy", hint: "import.sourceDokployHint", url: "import.baseUrlDokploy", ph: "import.baseUrlPlaceholderDokploy", tok: "import.tokenDokploy", tokHint: "import.tokenHintDokploy", fail: "import.connectFailedDokploy", name: "import.sourceNameDokploy", option: "import.sourceDokployOption" },
  caprover: { title: "import.sourceCaprover", hint: "import.sourceCaproverHint", url: "import.baseUrlCaprover", ph: "import.baseUrlPlaceholderCaprover", tok: "import.tokenCaprover", tokHint: "import.tokenHintCaprover", fail: "import.connectFailedCaprover", name: "import.sourceNameCaprover", option: "import.sourceCaproverOption" },
} as const;
/** Where the source panel creates API tokens, from the address typed so far. Null until it is a plain http(s) address, and for CapRover (a password, no token page). */
export function tokenPageUrl(kind: ImportRemoteKind, baseUrl: string): string | null {
  if (kind === "caprover") return null;
  try {
    const u = new URL(baseUrl.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return `${u.origin}${kind === "coolify" ? "/security/api-tokens" : "/dashboard/settings/profile"}`;
  } catch {
    return null;
  }
}
const NEEDS_KEY = { coolify: "import.needsCoolify", dokploy: "import.needsDokploy", caprover: "import.needsCaprover" } as const;
const SOURCE_KINDS: readonly ImportRemoteKind[] = ["coolify", "dokploy", "caprover"];
/** An operation's source kind (a string from the hub) narrowed to a wizard source; anything unknown reads as Coolify. */
const asRemoteKind = (k: string | null | undefined): ImportRemoteKind => (k === "dokploy" || k === "caprover" ? k : "coolify");

/** The import wizard: pick a source (Coolify / Dokploy / CapRover) → connect → preview (secret-free plan) → apply onto a
 *  target Tugra server → watch the live timeline. Local-docker container adoption keeps its own UI on a server's page. */
export function ImportWizard() {
  const t = useT();
  const toast = useToast();
  const { data: teams = [] } = useQuery({ queryKey: ["teams"], queryFn: () => api.listTeams() });
  const { data: servers = [], isPending: serversPending } = useQuery({ queryKey: ["servers"], queryFn: () => api.listServers() });
  const serversReady = !serversPending; // loaded, or failed: either way the in-place read must not wait forever
  const qc = useQueryClient();

  const [kind, setKind] = useState<ImportRemoteKind>("coolify");
  // Coolify can be read two ways: with an API token, or through the Tugra agent on the Coolify server (no token).
  const [connectMode, setConnectMode] = useState<"token" | "agent">("agent");
  // The agent path: the match of the Coolify servers to Tugra servers is checked once per session before the first step.
  const [matchedHosts, setMatchedHosts] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  /** True once the address field was left after its last edit: only then may the token be sent to it for the test. */
  const [urlConfirmed, setUrlConfirmed] = useState(false);
  const [token, setToken] = useState("");
  const [scopeLabel, setScopeLabel] = useState("");
  // The label is filled from the source team once the token tests; typing in it stops that.
  const [labelTouched, setLabelTouched] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [opId, setOpId] = useState<string | null>(null);
  // Per-database data mode chosen at review (PostgreSQL volume copy). Part of the plan: changing it re-plans, so the
  // planHash the apply is bound to always reflects what the owner reviewed.
  const [dbModes, setDbModes] = useState<Record<string, "volume">>({});
  // The first step's choice (what is moving, where each source server goes). Null until it is made.
  const [scope, setScope] = useState<ImportScope | null>(null);
  // What was picked last, so "Change" reopens the first step as it was left.
  const [lastSelection, setLastSelection] = useState<ScopeSelection | undefined>(undefined);
  // The step's live selection (kept in sessionStorage so a refresh resumes at the first step), and why a resume did not work.
  const liveSelection = useRef<ScopeSelection | undefined>(undefined);
  const [resumeNote, setResumeNote] = useState<"expired" | null>(null);
  // True while the step on screen is one a refresh brought back (a one-line note says why); gone once dismissed or the owner moves on.
  const [resumedStep, setResumedStep] = useState(false);
  // The picked Coolify team narrows the match, scope and placement lists; this opens them to every team.
  const [showAllTeams, setShowAllTeams] = useState(false);
  // With a team mapping saved: the one mapped Coolify team in view (null = all the mapped ones), and whether the mapping step is open again.
  const [teamView, setTeamView] = useState<string | null>(null);
  const [editingTeamMap, setEditingTeamMap] = useState(false);
  // Where the user came from (a server's scan card, the Read-this-Coolify page): the source address, and a server or project to start with.
  const [focus, setFocus] = useState<ImportFocus | null>(null);
  const focusRef = useRef<ImportFocus | null>(null);
  // A line for the first step saying what the click that brought the user here ticked for them (empty when nothing).
  const [startNote, setStartNote] = useState("");

  // There is no team to pick up front: the connection belongs to the team of the first server you can write to (else your first
  // team), and the target team follows from the server the import lands on.
  const writableServers = servers.filter((s) => s.canWrite);
  // read by the plan mutation's callback, which can outlive the render it was created in
  const writableRef = useRef(writableServers);
  writableRef.current = writableServers;
  const connectTeam = writableServers[0]?.teamId ?? teams[0]?.id ?? "";
  const effectiveTeam = (scope && servers.find((s) => s.id === scope.defaultServerId)?.teamId) || connectTeam;
  const src = SRC[kind];

  // The wizard's state is in-memory, so keep the running op in the URL (?op=<id>): a reload or a shared link
  // reopens the timeline and the cutover step instead of starting a new import.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get("op");
    if (fromUrl) setOpId(fromUrl);
    // "Move" on the Read-this-Coolify inventory hands the Coolify address over through same-tab storage (never the URL, so a
    // crafted link cannot prefill an attacker's host); the token step still asks for the token.
    let address: string | null = null;
    try {
      address = window.sessionStorage.getItem(IMPORT_PREFILL_KEY);
      window.sessionStorage.removeItem(IMPORT_PREFILL_KEY);
    } catch {
      /* storage unavailable */
    }
    const f = takeImportFocus();
    // A second run of this effect (React strict mode) finds the storage already cleared: keep what the first one read.
    if (f) {
      focusRef.current = f;
      setFocus(f);
    }
    const k: ImportRemoteKind = f?.kind ?? "coolify";
    if (f?.kind) setKind(f.kind);
    // The address handed over wins, then the one used for the last connection (an address only, never a token).
    const start = f?.address ?? (address && /^https?:\/\/\S+$/i.test(address) ? address : null) ?? lastImportUrl(k);
    if (start) setBaseUrl((cur) => cur || start);
    // Coolify opens on the agent (no token to make) unless an address was handed over or used last time.
    if (k !== "coolify" || start) setConnectMode("token");
  }, []);
  useEffect(() => {
    const url = new URL(window.location.href);
    if (opId) url.searchParams.set("op", opId);
    else if (url.searchParams.has("op")) url.searchParams.delete("op");
    else return;
    window.history.replaceState(window.history.state, "", url);
  }, [opId]);

  // A refresh keeps the wizard where it was: the hub session and the picked scope come back from sessionStorage, the plan is read
  // again (so the matches are current) and the first step opens on what was picked. The token is never stored.
  const resumed = useRef(false);
  useEffect(() => {
    if (resumed.current) return;
    resumed.current = true;
    if (new URLSearchParams(window.location.search).get("op")) return;
    // "Take over in place" from the checklist: the agent session is made already, so read its plan and open on that server.
    const agentSid = focusRef.current?.agentSessionId;
    if (agentSid) {
      clearImportResume();
      setKind("coolify");
      setConnectMode("agent");
      setSessionId(agentSid);
      inPlaceSession.current = agentSid; // read once the servers are known: the focus is placed on one of them
      return;
    }
    const r = loadImportResume();
    if (!r) return;
    setKind(r.kind);
    if (r.baseUrl) {
      setBaseUrl(r.baseUrl);
      setConnectMode("token"); // a session made with an address was a token session: the form it falls back to is the token one
    }
    setSessionId(r.sessionId);
    setDbModes(r.dbModes);
    setShowAllTeams(r.allTeams === true);
    setMatchedHosts(r.matched === true);
    setTeamView(r.view ?? null);
    setResumedStep(true);
    setLastSelection(r.selection);
    liveSelection.current = r.selection;
    planM.mutate({ sid: r.sessionId, kind: r.kind, modes: r.dbModes, resume: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Once an apply has started (or a finished op is reopened through ?op) the picks are spent: drop the resume record so a later
  // visit to the import page cannot re-plan the same source and reopen the scope step on the old picks.
  useEffect(() => {
    if (opId) clearImportResume();
  }, [opId]);
  useEffect(() => {
    if (sessionId && !opId) saveImportResume({ kind, baseUrl, sessionId, selection: liveSelection.current ?? lastSelection, dbModes, allTeams: showAllTeams, matched: matchedHosts, view: teamView ?? undefined });
  }, [sessionId, opId, kind, baseUrl, dbModes, lastSelection, scope, showAllTeams, matchedHosts, teamView]);

  const inPlaceSession = useRef<string | null>(null);
  useEffect(() => {
    const sid = inPlaceSession.current;
    if (!serversReady || !sid) return;
    inPlaceSession.current = null;
    planM.mutate({ sid, kind: "coolify", resume: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serversReady]);

  const planM = useMutation({
    mutationFn: (v: { sid: string; kind?: ImportRemoteKind; modes?: Record<string, "volume">; resume?: boolean }) =>
      api.importPlan({ sourceKind: v.kind ?? kind, sessionId: v.sid, ...(v.modes && Object.keys(v.modes).length ? { dbDataModes: v.modes } : {}) }),
    onSuccess: (p) => {
      setResumeNote(null);
      setPlan(p);
      // Start the first step on what the user came for (one server or project), once.
      const f = focusRef.current;
      const sel = focusSelection(p, f, writableRef.current.map((s) => ({ id: s.id, teamId: s.teamId })));
      if (sel) setLastSelection(sel);
      const what = focusSubject(p, sel);
      setStartNote(
        f?.inPlaceServerId
          ? what
            ? t("import.scope.startedInPlace", { name: what.name })
            : t("import.scope.inPlaceNotFound", { server: f.fromServerName ?? "" })
          : f?.fromItemName
          ? what
            ? t("import.scope.startedFromItem", { item: f.fromItemName, project: what.name })
            : t("import.scope.startedFromItemNone", { item: f.fromItemName })
          : what
            ? t("import.scope.startedFrom", { name: what.name })
            : "",
      );
      // An in-place focus that found nothing keeps waiting: the owner may still answer a match, and the re-read then ticks the server.
      if (sel || !f?.inPlaceServerId) focusRef.current = null;
    },
    onError: (e, v) => {
      if (v.resume) {
        // the hub session ended (it lives for an hour): start from the connect form again, with the address kept
        clearImportResume();
        setSessionId(null);
        setPlan(null);
        setLastSelection(undefined);
        setResumeNote("expired");
        return;
      }
      toast((e as Error).message, "error");
    },
  });
  const connect = useMutation({
    mutationFn: () => api.importConnect({ sourceKind: kind, teamId: connectTeam, baseUrl: baseUrl.trim(), token: token.trim(), ...(scopeLabel.trim() ? { scopeLabel: scopeLabel.trim() } : {}) }),
    onSuccess: (s) => {
      rememberLastImportUrl(kind, baseUrl.trim());
      if (kind === "caprover") setToken(""); // the password has been exchanged for a login; nothing keeps it
      setSessionId(s.sessionId);
      setScope(null);
      setLastSelection(undefined);
      planM.mutate({ sid: s.sessionId });
    },
    onError: (e) => toast((e as Error).message || t(src.fail), "error"),
  });

  const labelTouchedRef = useRef(false);
  labelTouchedRef.current = labelTouched;
  const test = useConnectionTest({
    kind,
    teamId: connectTeam,
    baseUrl,
    urlConfirmed,
    token,
    onResult: (r) => {
      if (r.ok && r.suggestedLabel && !labelTouchedRef.current) setScopeLabel(r.suggestedLabel);
    },
  });

  /** Switching source clears the URL and token (a Coolify token must never be sent to a Dokploy URL) and any stale error. */
  const pickKind = (next: ImportRemoteKind) => {
    if (next === kind) return;
    setKind(next);
    setConnectMode(next === "coolify" ? "agent" : "token");
    setBaseUrl("");
    setUrlConfirmed(false);
    setToken("");
    setScopeLabel("");
    setLabelTouched(false);
    connect.reset();
    planM.reset();
  };

  const reset = () => {
    clearImportResume();
    liveSelection.current = undefined;
    setResumeNote(null);
    setResumedStep(false);
    setShowAllTeams(false);
    setTeamView(null);
    setEditingTeamMap(false);
    setDbModes({});
    setPlan(null);
    setScope(null);
    setLastSelection(undefined);
    setStartNote("");
    setSessionId(null);
    setOpId(null);
    setToken("");
    setMatchedHosts(false);
    connect.reset();
    planM.reset();
  };

  // "Start over" on the first step also ends the hub session, so the stored token stops being usable now instead of at its expiry.
  const startOver = () => {
    if (sessionId) api.importRevoke(sessionId).catch(() => undefined);
    reset();
  };
  const onSelectionChange = useCallback(
    (sel: ScopeSelection) => {
      liveSelection.current = sel;
      if (sessionId) saveImportResume({ kind, baseUrl, sessionId, selection: sel, dbModes, allTeams: showAllTeams, matched: matchedHosts, view: teamView ?? undefined });
    },
    [sessionId, kind, baseUrl, dbModes, showAllTeams, matchedHosts, teamView],
  );
  // a server was just added or an agent came online: read the servers and the plan again so the matches are current
  const recheck = () => {
    void qc.invalidateQueries({ queryKey: ["servers"] });
    if (sessionId) planM.mutate({ sid: sessionId, modes: dbModes });
  };

  const busy = connect.isPending || planM.isPending;
  if (opId) {
    // The settings step needs the live source session: after a reload (?op=) there is none, so it is simply not offered.
    const teamServers = servers.filter((sv) => sv.teamId === effectiveTeam).map((sv) => ({ id: sv.id, name: sv.name }));
    return <Timeline opId={opId} onReset={reset} settings={sessionId ? { sessionId, kind, servers: teamServers, teamId: effectiveTeam } : undefined} />;
  }

  // The agent path, a Coolify with several teams: which Tugra team each Coolify team goes into, decided before anything is matched or placed.
  const tScope = teamScope(plan, teamView);
  if (plan && sessionId && (editingTeamMap || (plan.preflight?.teamMap === undefined && coolifyTeams(plan).length >= 2))) {
    return (
      <div style={{ display: "grid", gap: 16 }}>
        {resumedStep && <div style={{ maxWidth: 720 }}><ResumeNote onDismiss={() => setResumedStep(false)} /></div>}
        <TeamMapStep
          // the starting choices read the team list once: start again when the list first arrives
          key={teams.length > 0 ? "teams" : "loading"}
          plan={plan}
          sessionId={sessionId}
          teams={teams}
          onDone={(teamMap) => {
            setResumedStep(false);
            setEditingTeamMap(false);
            setTeamView(null);
            setPlan((p) => (p ? { ...p, preflight: { ...p.preflight!, teamMap } } : p));
          }}
          onStartOver={startOver}
        />
      </div>
    );
  }

  // The agent path: which Tugra server is each Coolify server, checked (and answered by the owner where unsure) before anything is placed.
  if (plan && sessionId && !matchedHosts && needsMatchStep(plan)) {
    const hostId = plan.preflight?.agentRead?.agentServerId;
    const host = servers.find((s) => s.id === hostId);
    return (
      <div style={{ display: "grid", gap: 16 }}>
        {resumedStep && <div style={{ maxWidth: 720 }}><ResumeNote onDismiss={() => setResumedStep(false)} /></div>}
        <AgentMatchStep
          plan={plan}
          sessionId={sessionId}
          servers={servers}
          teamId={host?.teamId ?? effectiveTeam}
          coolifyServer={host ? { id: host.id, name: host.name } : null}
          onContinue={() => { setResumedStep(false); setMatchedHosts(true); }}
          onRecheck={recheck}
          onStartOver={startOver}
          rechecking={planM.isPending}
          teamScope={tScope}
          showAllTeams={showAllTeams}
          onShowAllTeams={setShowAllTeams}
          teamView={teamView}
          onTeamView={setTeamView}
          onChangeTeamMap={() => setEditingTeamMap(true)}
        />
      </div>
    );
  }

  if (plan && sessionId && !scope && plan.mapping?.features?.includes("mapping-v1")) {
    return (
      <div style={{ display: "grid", gap: 16 }}>
        {resumedStep && <div style={{ maxWidth: 720 }}><ResumeNote onDismiss={() => setResumedStep(false)} /></div>}
      <ImportScopeStep
        plan={plan}
        servers={writableServers.map((s) => ({ id: s.id, name: s.name, teamId: s.teamId, status: s.status, capabilities: s.capabilities, lastSeenAt: s.lastSeenAt }))}
        teams={teams}
        initial={lastSelection ?? liveSelection.current}
        onContinue={(sc) => { focusRef.current = null; setResumedStep(false); setScope(sc); setLastSelection(sc.selection); }}
        onStartOver={startOver}
        onSelectionChange={onSelectionChange}
        onRecheck={recheck}
        startNote={startNote || undefined}
        rechecking={planM.isPending}
        teamScope={tScope}
        showAllTeams={showAllTeams}
        onShowAllTeams={setShowAllTeams}
        teamView={teamView}
        onTeamView={setTeamView}
        onChangeTeamMap={() => setEditingTeamMap(true)}
      />
      </div>
    );
  }

  if (plan && sessionId) {
    return (
      <PlanView
        plan={scope ? scopedPlan(plan, scope.inScope) : plan}
        fullPlan={plan}
        scope={scope}
        onChangeScope={() => setScope(null)}
        kind={kind}
        servers={servers.filter((s) => s.teamId === effectiveTeam).map((s) => ({ id: s.id, name: s.name }))}
        writableServers={servers.filter((s) => s.canWrite).map((s) => ({ id: s.id, name: s.name, teamId: s.teamId, status: s.status, capabilities: s.capabilities, canWrite: s.canWrite }))}
        teams={teams}
        sessionId={sessionId}
        dbModes={dbModes}
        replanning={planM.isPending}
        onDbModes={(next) => {
          setDbModes(next);
          planM.mutate({ sid: sessionId, modes: next });
        }}
        onApplied={setOpId}
        onReset={reset}
        agentHost={(() => {
          const h = servers.find((x) => x.id === plan.preflight?.agentRead?.agentServerId);
          return h ? { id: h.id, name: h.name, teamId: h.teamId } : null;
        })()}
        onRecheck={recheck}
      />
    );
  }

  return (
    <SectionCard title={t(src.title)} desc={t(kind === "coolify" && connectMode === "agent" ? "import.sourceCoolifyAgentHint" : src.hint)} style={{ padding: 20, maxWidth: 560, marginBottom: 0 }}>
      {resumeNote === "expired" && <p role="status" style={{ fontSize: 12, color: "var(--c-am)", margin: "0 0 12px" }}>{t("import.resumeExpired")}</p>}
      {focus?.fromServerName && <p role="note" style={{ fontSize: 12, color: "var(--c-tx2)", margin: "0 0 10px" }}>{t("import.fromServer", { server: focus.fromServerName })}</p>}
      {!(kind === "coolify" && connectMode === "agent") && (
        <>
      <p data-testid="import-needs" style={{ fontSize: 13, margin: "0 0 4px" }}>{t(NEEDS_KEY[kind])}</p>
      <MoreInfo label={t("import.needsMore")} style={{ margin: "0 0 14px" }}>
        {tokenPageUrl(kind, baseUrl) && (
          <p style={{ margin: "0 0 6px" }}>
            <a href={tokenPageUrl(kind, baseUrl) ?? undefined} target="_blank" rel="noopener noreferrer" style={{ color: "var(--c-lapis)" }}>{t(kind === "coolify" ? "import.tokenPageCoolify" : "import.tokenPageDokploy")}</a>
          </p>
        )}
        {kind === "coolify" && (
          <p style={{ margin: 0 }}>
            {t("import.readFirst")} <Link href="/import/coolify-host" style={{ color: "var(--c-lapis)" }}>{t("coolifyTakeover.title")}</Link>
          </p>
        )}
      </MoreInfo>
        </>
      )}

      <div id="imp-source-label" style={label}>{t("import.sourcePicker")}</div>
      <div role="radiogroup" aria-labelledby="imp-source-label" style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
        {SOURCE_KINDS.map((k) => {
          const checked = k === kind;
          return (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={checked}
              disabled={busy}
              onClick={() => pickKind(k)}
              style={{
                flex: "1 1 200px",
                minHeight: 44,
                fontFamily: "inherit",
                fontSize: 13,
                fontWeight: 600,
                padding: "8px 14px",
                borderRadius: "var(--r1)",
                cursor: busy ? "not-allowed" : "pointer",
                opacity: busy ? 0.6 : 1,
                border: "1px solid var(--c-bd)",
                background: checked ? "var(--c-a)" : "var(--c-el)",
                color: checked ? "var(--c-on-a)" : "var(--c-tx)",
              }}
            >
              {t(SRC[k].option)}
            </button>
          );
        })}
      </div>

      {kind === "coolify" && (
        <>
          <div id="imp-mode-label" style={label}>{t("coolifyAgent.choice.title")}</div>
          <div role="group" aria-labelledby="imp-mode-label" style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
            {(["agent", "token"] as const).map((m) => {
              const checked = m === connectMode;
              return (
                <button
                  key={m}
                  type="button"
                  aria-pressed={checked}
                  disabled={busy}
                  onClick={() => setConnectMode(m)}
                  style={{
                    flex: "1 1 200px",
                    minHeight: 44,
                    fontFamily: "inherit",
                    fontSize: 13,
                    fontWeight: 600,
                    padding: "8px 14px",
                    borderRadius: "var(--r1)",
                    cursor: busy ? "not-allowed" : "pointer",
                    opacity: busy ? 0.6 : 1,
                    border: "1px solid var(--c-bd)",
                    background: checked ? "var(--c-a)" : "var(--c-el)",
                    color: checked ? "var(--c-on-a)" : "var(--c-tx)",
                  }}
                >
                  {t(m === "agent" ? "coolifyAgent.choice.agent" : "coolifyAgent.choice.api")}
                </button>
              );
            })}
          </div>
        </>
      )}

      {kind === "coolify" && connectMode === "agent" ? (
        <AgentConnectPanel
          servers={servers}
          busy={planM.isPending}
          onConnected={(s) => {
            setSessionId(s.sessionId);
            setScope(null);
            setLastSelection(undefined);
            setMatchedHosts(false);
            planM.mutate({ sid: s.sessionId });
          }}
        />
      ) : (
      <>
      <label style={label} htmlFor="imp-url">{t(src.url)}</label>
      <input id="imp-url" style={field} value={baseUrl} onChange={(e) => { setBaseUrl(e.target.value); setUrlConfirmed(false); if (connect.isError) connect.reset(); }} onBlur={() => setUrlConfirmed(true)} placeholder={t(src.ph)} inputMode="url" autoComplete="off" spellCheck={false} />

      <label style={label} htmlFor="imp-token">{t(src.tok)}</label>
      <input id="imp-token" style={field} type="password" value={token} onChange={(e) => { setToken(e.target.value); if (connect.isError) connect.reset(); }} autoComplete="off" aria-describedby="imp-token-hint" />
      <p id="imp-token-hint" style={{ fontSize: 12, color: "var(--c-tx3)", margin: "-6px 0 6px" }}>{t(src.tokHint)}</p>
      <MoreInfo>
        {kind === "coolify" ? (
          <>
            <ul style={{ margin: "0 0 6px", paddingLeft: 16 }}>
              <li>{t("import.tokenMore.scope")}</li>
              <li>{t("import.tokenMore.sensitive")}</li>
              <li>{t("import.tokenMore.deploy")}</li>
              <li>{t("import.tokenMore.pace")}</li>
            </ul>
            <p style={{ margin: 0 }}>
              <a href={guideUrl("move-from-coolify")} target="_blank" rel="noopener noreferrer" style={{ color: "var(--c-lapis)" }}>{t("import.tokenMore.guide")}</a>
              {" · "}
              <a href={guideUrl("move-from-coolify-same-server")} target="_blank" rel="noopener noreferrer" style={{ color: "var(--c-lapis)" }}>{t("import.tokenMore.sameServer")}</a>
            </p>
          </>
        ) : kind === "caprover" ? (
          <p style={{ margin: 0 }}>
            {t("import.tokenMoreCaprover")}{" "}
            <a href={guideUrl("move-from-caprover")} target="_blank" rel="noopener noreferrer" style={{ color: "var(--c-lapis)" }}>{t("import.tokenMore.guide")}</a>
          </p>
        ) : (
          <p style={{ margin: 0 }}>{t("import.tokenMoreDokploy")}</p>
        )}
      </MoreInfo>

      <ConnectionStatus test={test} connectError={connect.isError ? (connect.error as Error) : null} source={t(src.name)} kind={kind} />

      <MoreInfo label={t("import.advanced")}>
        <label style={label} htmlFor="imp-scope">{t("import.review.scopeLabel")}</label>
        <input id="imp-scope" style={field} value={scopeLabel} onChange={(e) => { setLabelTouched(true); setScopeLabel(e.target.value.toLowerCase()); }} placeholder="team-3" maxLength={64} autoComplete="off" spellCheck={false} aria-describedby="imp-scope-hint" />
        <p id="imp-scope-hint" style={{ fontSize: 12, color: "var(--c-tx3)", margin: "-6px 0 0" }}>{t("import.review.scopeLabelHelp")}</p>
      </MoreInfo>

      <Btn onClick={() => connect.mutate()} loading={busy} disabled={!connectTeam || !baseUrl.trim() || !token.trim()}>
        {connect.isPending ? t("import.connecting") : planM.isPending ? t("import.planning") : t("import.connect")}
      </Btn>
      </>
      )}

      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "16px 0 0" }}>
        {t("import.localDockerHint")} <Link href="/servers" style={{ color: "var(--c-lapis)" }}>{t("import.localDockerLink")}</Link>
      </p>
    </SectionCard>
  );
}

function PlanView({
  plan,
  fullPlan,
  scope,
  onChangeScope,
  kind,
  servers,
  writableServers,
  teams,
  sessionId,
  dbModes,
  replanning,
  onDbModes,
  onApplied,
  onReset,
  agentHost,
  onRecheck,
}: {
  /** The plan as shown here: only what the first step left in scope. */
  plan: ImportPlan;
  /** The whole plan (the review step lists everything so an item left out can be brought back). */
  fullPlan: ImportPlan;
  scope: ImportScope | null;
  onChangeScope: () => void;
  kind: ImportRemoteKind;
  servers: { id: string; name: string }[];
  writableServers: { id: string; name: string; teamId: string; status?: "PENDING" | "ONLINE" | "OFFLINE"; capabilities?: string[]; canWrite?: boolean }[];
  teams: Team[];
  sessionId: string;
  dbModes: Record<string, "volume">;
  replanning: boolean;
  onDbModes: (next: Record<string, "volume">) => void;
  onApplied: (opId: string) => void;
  onReset: () => void;
  /** Agent session: the Tugra server that reads Coolify, to ask for the consent again where the apply is. */
  agentHost: { id: string; name: string; teamId: string } | null;
  /** Read the plan again (what consent stands is part of it). */
  onRecheck: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const s = planSummary(plan);
  // Where the data goes: what stays on its own machine keeps its data (no copy, no migrator, no data mode), only what moves to another server needs those.
  const { moved, stays } = splitByPlacement(plan, scope);
  // An agent session cannot be applied without the owner's consent for secret values standing now: the controls stay off until it does.
  const consentMissing = needsConsent(fullPlan);
  const groups = itemsByKind(plan);
  const [targetServerId, setTargetServerId] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const target = targetServerId || (scope && servers.some((s) => s.id === scope.defaultServerId) ? scope.defaultServerId : "") || servers[0]?.id || "";
  // Strict env (Coolify): apps acknowledged to be created WITHOUT the variables Tugra cannot carry. Apply stays
  // disabled until every ackable blocker is acknowledged; a non-ackable blocker (token cannot read values) never is.
  const [acked, setAcked] = useState<ReadonlySet<string>>(new Set());
  const unackedCount = ackableItems(plan).filter((it) => !acked.has(it.itemRef)).length;
  const runnable = runnableAfterAcks(plan, acked);

  // Per-service choices (keyed by plan itemRef). Only what the operator changed is sent; an untouched card sends nothing.
  const [choices, setChoices] = useState<Record<string, ImportServiceChoice>>({});
  const [missingTargets, setMissingTargets] = useState(0);
  const onChoice = (ref: string, patch: ImportServiceChoice | null) =>
    setChoices((prev) => {
      const next = { ...prev };
      if (patch === null) delete next[ref];
      else next[ref] = patch;
      return next;
    });
  // A service stack the first step left out is skipped by choice; what the operator chose for the rest rides on top.
  const scopeSkips = scope?.narrowed ? scopeServiceSkips(fullPlan, scope.inScope) : {};
  const chosen = serviceChoicesPayload(plan, choices);
  const serviceChoices = Object.keys(scopeSkips).length || chosen ? { ...scopeSkips, ...(chosen ?? {}) } : undefined;

  // An older hub omits the feature flag: keep the original one-click apply, no review step.
  const mappingSupported = !!plan.mapping?.features?.includes("mapping-v1");

  // What every apply (this one-click one AND the review step's) must carry from this screen.
  const acks = buildAcks(plan, acked);
  const modes = selectedDbModes(plan);
  const applyExtras: ImportApplyExtras = { ...(acks.length ? { acks } : {}), ...(serviceChoices ? { serviceChoices } : {}), ...(Object.keys(modes).length ? { dbDataModes: modes } : {}) };

  const apply = useMutation({
    mutationFn: () => api.importApply({ sourceKind: kind, sessionId, targetServerId: target, planHash: plan.planHash, ...applyExtras }),
    onSuccess: (r) => onApplied(r.opId),
    onError: (e) => {
      if (isConsentRequired(e)) {
        toast(t("coolifySecrets.error.consent_required"), "error");
        onRecheck(); // the plan no longer shows a consent: the card to allow it again appears below
        return;
      }
      toast((e as Error).message, "error");
    },
  });

  if (reviewing && mappingSupported) {
    return (
      <ImportReviewStep
        plan={fullPlan}
        importScope={scope}
        kind={kind}
        sessionId={sessionId}
        servers={writableServers}
        teams={teams}
        applyExtras={applyExtras}
        onApplied={onApplied}
        onBack={() => setReviewing(false)}
        onConsentRequired={() => {
          setReviewing(false);
          onRecheck();
        }}
      />
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 720 }}>
      <SectionCard
        title={t("import.planTitle")}
        right={
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {scope && <Btn variant="ghost" onClick={onChangeScope}>{t("import.scope.change")}</Btn>}
            <Btn variant="ghost" onClick={onReset}>{t("import.startOver")}</Btn>
          </div>
        }
        style={{ padding: 20, marginBottom: 0 }}
      >
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Stat label={t("import.apps")} value={s.apps} />
          <Stat label={t("import.databases")} value={s.databases} />
          <Stat label={t("import.volumes")} value={s.volumes} />
          <Stat label={t("import.blockers")} value={s.blockers} danger={s.blockers > 0} />
        </div>
        {plan.warnings.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 4 }}>{t("import.warnings")}</div>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: "var(--c-am)" }}>
              {plan.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        )}

        {stays.length > 0 && <InPlaceDataNote stays={stays} />}

        {plan.preflight && (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 6 }}>{t("import.preflightTitle")}</div>
            {moved.preflight && moved.preflight.databases.length > 0 && (
              <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 4 }}>
                {moved.preflight?.databases.map((d, i) => (
                  <li key={i} style={{ fontSize: 12, display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                    <span
                      style={{
                        fontWeight: 700,
                        minWidth: 76,
                        color: d.dataPlane === "one-click" || d.dataPlane === "volume" ? "var(--c-g)" : d.dataPlane === "manual" ? "var(--c-am)" : "var(--c-r)",
                      }}
                    >
                      {d.dataPlane === "one-click" ? t("import.dataAuto") : d.dataPlane === "volume" ? t("import.dataVolume") : d.dataPlane === "manual" ? t("import.dataManual") : t("import.dataBlocked")}
                    </span>
                    <span className="mono">{d.name} ({d.engine})</span>
                    <span style={{ color: "var(--c-tx3)" }}>— {d.reason}</span>
                  </li>
                ))}
              </ul>
            )}
            {plan.preflight.services.some((sv) => sv.verdict !== "skipped") && (
              <div style={{ marginTop: 10 }}>
                <div style={{ fontSize: 12, color: "var(--c-g)", marginBottom: 4 }}>
                  {t("import.servicesImported", { count: String(plan.preflight.services.filter((sv) => sv.verdict !== "skipped").length) })}
                </div>
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: "var(--c-tx3)" }}>
                  {plan.preflight.services.filter((sv) => sv.verdict !== "skipped").map((sv, i) => (
                    <li key={i}>
                      <span className="mono">{sv.name}{sv.members > 0 ? ` (${sv.members})` : ""}</span> — {sv.note}
                      {sv.objectStore && (
                        <>
                          {" "}
                          <a href="/migrations/objects/new" target="_blank" rel="noopener noreferrer" title={t("objectMigration.migrateObjectsHint")} onClick={() => rememberObjectMigrationContext({ ...(target ? { targetServerId: target } : {}), serviceName: sv.name })}>{t("objectMigration.migrateObjects")}</a>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {plan.preflight.services.some((sv) => sv.verdict === "skipped") && (
              <div style={{ marginTop: 10 }}>
                <div style={{ fontSize: 12, color: "var(--c-am)", marginBottom: 4 }}>
                  {t("import.servicesSkipped", { count: String(plan.preflight.services.filter((sv) => sv.verdict === "skipped").length) })}
                </div>
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: "var(--c-tx3)" }}>
                  {plan.preflight.services.filter((sv) => sv.verdict === "skipped").map((sv, i) => (
                    <li key={i}><span className="mono">{sv.name}{sv.members > 0 ? ` (${sv.members})` : ""}</span> — {sv.note}</li>
                  ))}
                </ul>
              </div>
            )}
            {plan.preflight.volumeDataNote && movedHasVolumeData(moved, stays.length > 0) && (
              <p style={{ fontSize: 12, color: "var(--c-am)", margin: "10px 0 0" }}>{plan.preflight.volumeDataNote}</p>
            )}
            {(moved.preflight?.volumes ?? []).some((v) => v.dataPlane === "stream") && (
              <p style={{ fontSize: 11, color: "var(--c-tx3)", margin: "8px 0 0" }}>{t("import.vx.warn.fidelity")}</p>
            )}
          </div>
        )}

        <DbDataModes plan={moved} modes={dbModes} busy={replanning} onChange={onDbModes} />

        {consentMissing && (
          <div style={{ marginTop: 14 }}>
            <AgentConsentGate plan={fullPlan} sessionId={sessionId} host={agentHost} onChanged={onRecheck} />
          </div>
        )}

        <div style={{ borderTop: "1px solid var(--c-bd)", margin: "16px 0 14px" }} />
        {scope?.multiTeam ? (
          // one apply (and its mapping review) belongs to one team: servers of several teams move through the guided run, one campaign per team
          <p role="note" data-testid="multi-team-guided" style={{ fontSize: 12, color: "var(--c-tx2)", margin: "0 0 8px", lineHeight: 1.5 }}>{t("import.scope.multiTeamGuided")}</p>
        ) : mappingSupported ? (
          <>
            {missingTargets > 0 && <p role="alert" style={{ fontSize: 12, color: "var(--c-am)", margin: "0 0 8px" }}>{t("import.services.needsTarget")}</p>}
            <Btn onClick={() => setReviewing(true)} disabled={replanning || consentMissing || runnable === 0 || unackedCount > 0 || missingTargets > 0}>{t("import.review.continue")}</Btn>
          </>
        ) : (
        <>
        <label style={label} htmlFor="imp-target">{t("import.target")}</label>
        {servers.length === 0 ? (
          <p style={{ fontSize: 12, color: "var(--c-am)", margin: "0 0 8px" }}>{t("import.noTarget")}</p>
        ) : (
          <select id="imp-target" style={{ ...field, maxWidth: 320 }} value={target} onChange={(e) => setTargetServerId(e.target.value)}>
            {servers.map((sv) => (
              <option key={sv.id} value={sv.id}>{sv.name}</option>
            ))}
          </select>
        )}
        <p style={{ fontSize: 11, color: "var(--c-tx3)", margin: "-4px 0 12px" }}>{t("import.targetHint")}</p>
        {missingTargets > 0 && <p role="alert" style={{ fontSize: 12, color: "var(--c-am)", margin: "0 0 8px" }}>{t("import.services.needsTarget")}</p>}
        <Btn onClick={() => apply.mutate()} loading={apply.isPending} disabled={replanning || consentMissing || !target || runnable === 0 || unackedCount > 0 || missingTargets > 0}>
          {apply.isPending ? t("import.applying") : t("import.apply")}
        </Btn>
        </>
        )}
        {kind !== "caprover" && <GuidedRunLauncher plan={plan} kind={kind} sessionId={sessionId} servers={writableServers} teams={teams} extras={applyExtras} scope={scope} onChangeScope={onChangeScope} onRecheck={onRecheck} disabled={replanning || consentMissing || runnable === 0 || unackedCount > 0 || missingTargets > 0} />}
      </SectionCard>

      <EnvBlockers plan={plan} acked={acked} onChange={setAcked} />
      {target && (plan.preflight?.git?.hosts.length ?? 0) > 0 && <GitLinksPanel sessionId={sessionId} targetServerId={target} plan={plan} />}
      <CoverageCard plan={plan} />
      <ImportSettingsPanel sessionId={sessionId} kind={kind} teamId={writableServers.find((w) => w.id === target)?.teamId} servers={servers} />
      <ImportServicesPanel sessionId={sessionId} kind={kind} plan={plan} servers={servers} choices={choices} onChoice={onChoice} onMissingTargets={setMissingTargets} />
      <Section title={t("import.appsSection")} items={groups.app} />
      <Section title={t("import.databasesSection")} items={groups.database} />
      {groups.volume.length > 0 && <Section title={t("import.volumesSection")} items={groups.volume} />}
    </div>
  );
}

function Timeline({ opId, onReset, settings }: { opId: string; onReset: () => void; settings?: { sessionId: string; kind: ImportRemoteKind; servers: Array<{ id: string; name: string }>; teamId?: string } }) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data: op } = useQuery({
    queryKey: ["import-op", opId],
    queryFn: () => api.getImportOperation(opId),
    refetchInterval: (q) => {
      const d = q.state.data as ImportOperation | undefined;
      return d && opProgress(d).settled ? false : 2000;
    },
  });

  const cancel = useMutation({
    mutationFn: () => api.cancelImport(opId),
    onError: (e) => toast((e as Error).message, "error"),
  });
  const rollback = useMutation({
    mutationFn: () => api.rollbackImport(opId),
    onSuccess: (updated) => qc.setQueryData(["import-op", opId], updated),
    onError: (e) => toast((e as Error).message, "error"),
  });
  const onRollback = async () => {
    const ok = await confirm({ title: t("import.rollbackTitle"), body: t("import.rollbackBody"), danger: true });
    if (ok) rollback.mutate();
  };

  if (!op) {
    return (
      <Card style={{ padding: 20, maxWidth: 720, display: "flex", alignItems: "center", gap: 10 }}>
        <Spinner /> {t("import.timelineTitle")}
      </Card>
    );
  }

  const prog = opProgress(op);
  const canRollback = prog.settled && op.tasks.some((task) => task.status === "DONE" && task.resourceType === "application");
  // Post-import steps only make sense once apps have actually landed (same condition as rollback).
  const showPostSteps = canRollback || (prog.settled && op.tasks.some((task) => task.status === "DONE" && task.resourceType === "database"));
  return (
    <>
    <Card style={{ padding: 20, maxWidth: 720 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
        <div style={{ fontWeight: 600, flex: 1 }}>{t("import.timelineTitle")} <span style={{ color: "var(--c-tx3)", fontWeight: 400 }}>· {op.status}</span></div>
        {!prog.settled && (
          <Btn variant="ghost" onClick={() => cancel.mutate()} loading={cancel.isPending || op.cancelRequested} disabled={op.cancelRequested}>
            {cancel.isPending || op.cancelRequested ? t("import.cancelling") : t("import.cancel")}
          </Btn>
        )}
        {canRollback && (
          <Btn variant="ghost" onClick={onRollback} loading={rollback.isPending}>
            {rollback.isPending ? t("import.rollingBack") : t("import.rollback")}
          </Btn>
        )}
        {prog.settled && <Btn variant="ghost" onClick={onReset}>{t("import.startOver")}</Btn>}
      </div>

      <div role="progressbar" aria-valuenow={prog.pct} aria-valuemin={0} aria-valuemax={100} style={{ height: 8, background: "var(--c-sur)", borderRadius: 4, overflow: "hidden", marginBottom: 6 }}>
        <div style={{ width: `${prog.pct}%`, height: "100%", background: prog.failed > 0 ? "var(--c-am)" : "var(--c-g)", transition: "width .4s" }} />
      </div>
      <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 14 }}>
        {prog.done}/{prog.total} · {prog.pct}%{prog.failed > 0 ? ` · ${t("import.failedCount", { n: prog.failed })}` : ""}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {op.tasks.map((task, i) => (
          <div key={task.itemRef ?? i} style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 8, fontSize: 12, borderBottom: "1px solid var(--c-bd)", paddingBottom: 6 }}>
            <span style={{ color: statusColor(task.status), fontWeight: 600, minWidth: 90 }}>{task.status}</span>
            <span className="mono" style={{ flex: 1, wordBreak: "break-all" }}>
              {task.name ?? task.itemRef}
              {task.mapped && task.sourceName && task.sourceName !== task.name && <span style={{ color: "var(--c-tx3)", marginLeft: 8, fontFamily: "inherit" }}>{t("import.review.wasName", { name: task.sourceName })}</span>}
            </span>
            {typeof task.unresolvedEnv === "number" && task.unresolvedEnv > 0 && (
              <span style={{ color: "var(--c-am)" }}>{t("import.unresolvedEnv", { n: task.unresolvedEnv })}</span>
            )}
            {task.unresolvedKeys && task.unresolvedKeys.length > 0 && (
              <span className="mono" style={{ color: "var(--c-am)", flexBasis: "100%", paddingLeft: 98, wordBreak: "break-all" }}>
                {t("import.env.taskNote", { keys: task.unresolvedKeys.slice(0, 20).join(", ") + (task.unresolvedKeys.length > 20 ? ` ${t("import.env.keysMore", { n: task.unresolvedKeys.length - 20 })}` : "") })}
              </span>
            )}
            {task.message && <span style={{ color: "var(--c-tx3)", flexBasis: "100%", paddingLeft: 98 }}>{task.message}</span>}
            {task.git?.deployKeyPublic && <DeployKeyBlock publicKey={task.git.deployKeyPublic} />}
            <TaskNotCarried task={task} />
            {task.service && <ServiceTaskDetails task={task} />}
          </div>
        ))}
      </div>
    </Card>
    {showPostSteps && (
      <>
        {asRemoteKind(op.sourceKind) === "caprover" ? (
          <SectionCard title={t("import.caproverDataTitle")} desc={t("import.caproverDataDesc")} style={{ padding: 20, maxWidth: 720, marginTop: 16, marginBottom: 0 }}>
            <a href={guideUrl("move-from-caprover")} target="_blank" rel="noopener noreferrer" style={{ color: "var(--c-lapis)", fontSize: 13 }}>{t("import.tokenMore.guide")}</a>
          </SectionCard>
        ) : (
          <>
            <MigrateDataCard opId={opId} sourceKind={asRemoteKind(op.sourceKind)} />
            <ImportVolumeTransfers opId={opId} />
          </>
        )}
        <RemapEnvCard opId={opId} sourceKind={asRemoteKind(op.sourceKind)} />
        {op.tasks.some((task) => task.git && task.git.status !== "linked" && task.git.status !== "public_ok") && <GitRelinkCard opId={opId} />}
        {settings && <ImportSettingsPanel sessionId={settings.sessionId} kind={settings.kind} opId={opId} teamId={settings.teamId} servers={settings.servers} />}
        <CutoverPanel opId={opId} />
      </>
    )}
    </>
  );
}

/** A copyable one-line command (mono, with a Copy button); `muted` greys it as a template, not a live command. */
function CommandBox({ cmd, muted }: { cmd: string; muted?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 8, background: "var(--c-sur)", border: "1px solid var(--c-bd)", borderRadius: 8, padding: 10 }}>
      <code className="mono" style={{ flex: 1, fontSize: 11, wordBreak: "break-all", whiteSpace: "pre-wrap", color: muted ? "var(--c-tx3)" : "var(--c-tx)" }}>{cmd}</code>
      <CopyBtn text={cmd} />
    </div>
  );
}

/** Post-import step 1 — database DATA migration: mint the one-time token and show the one-liner the operator
 *  pastes on the SOURCE host to pull each database's data over. The live command is shown once; after that the
 *  read-only state shows active/expiry + a Reissue. */
function MigrateDataCard({ opId, sourceKind = "coolify" }: { opId: string; sourceKind?: ImportRemoteKind }) {
  const t = useT();
  const toast = useToast();
  const [minted, setMinted] = useState<MintedMigrationToken | null>(null);
  const [stopSource, setStopSource] = useState(false);
  const [allowBind, setAllowBind] = useState(false);
  const { data: state } = useQuery({ queryKey: ["migrate-command", opId], queryFn: () => api.getMigrateCommand(opId) });
  const mint = useMutation({
    mutationFn: (reissue: boolean) => (reissue ? api.reissueMigrationToken(opId) : api.mintMigrationToken(opId)),
    onSuccess: (r) => setMinted(r),
    onError: (e) => toast((e as Error).message, "error"),
  });
  const active = !!state?.active;
  const vxCmds: VxCommands | undefined = minted ? minted.commands : state?.commandsTemplate;
  const flags = { stopSource, allowBind };
  const shown = vxCmds ? vxCommandsWithFlags(vxCmds, flags) : null;
  return (
    <SectionCard title={t("import.migrateTitle")} desc={t("import.migrateDesc", { source: t(SRC[sourceKind].name) })} style={{ padding: 20, maxWidth: 720, marginTop: 16, marginBottom: 0 }}>
      {shown && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>{t("import.vx.commands.title")}</div>
          <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "2px 0 10px" }}>{t("import.vx.commands.desc")}</p>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
            <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12 }}>
              <input type="checkbox" checked={stopSource} onChange={(e) => setStopSource(e.target.checked)} style={{ marginTop: 2 }} />
              <span>
                {t("import.vx.commands.stopSourceLabel")}
                <span style={{ display: "block", color: stopSource ? "var(--c-am)" : "var(--c-tx3)" }}>{t("import.vx.warn.stopSource")}</span>
              </span>
            </label>
            <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12 }}>
              <input type="checkbox" checked={allowBind} onChange={(e) => setAllowBind(e.target.checked)} style={{ marginTop: 2 }} />
              <span>
                {t("import.vx.commands.allowBindLabel")}
                <span style={{ display: "block", color: allowBind ? "var(--c-am)" : "var(--c-tx3)" }}>{t("import.vx.warn.allowBind")}</span>
              </span>
            </label>
          </div>
          {(["dryRun", "run", "resume"] as const).map((k) => (
            <div key={k} style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>{t(`import.vx.commands.${k}`)}</div>
              <CommandBox cmd={shown[k]} muted={!minted} />
            </div>
          ))}
          <p style={{ fontSize: 11, color: "var(--c-tx3)", margin: 0 }}>{t("import.vx.commands.tokenWarn")}</p>
        </div>
      )}
      {minted ? (
        <>
          <div style={{ fontSize: 12, color: "var(--c-am)", marginBottom: 6 }}>{t("import.migrateTokenOnce")}</div>
          {!shown && <CommandBox cmd={minted.command} />}
          <div style={{ fontSize: 11, color: "var(--c-tx3)", marginTop: 6 }}>{t("import.migrateExpires", { date: new Date(minted.expiresAt).toLocaleString() })}</div>
        </>
      ) : (
        <>
          {active && <div style={{ fontSize: 12, color: "var(--c-g)", marginBottom: 8 }}>{t("import.migrateActive", { date: state?.expiresAt ? new Date(state.expiresAt).toLocaleString() : "" })}</div>}
          {!shown && state?.commandTemplate && <CommandBox cmd={state.commandTemplate} muted />}
          <div style={{ marginTop: 10 }}>
            <Btn onClick={() => mint.mutate(active)} loading={mint.isPending}>
              {mint.isPending ? t("import.migrateMinting") : active ? t("import.migrateReissue") : t("import.migrateGenerate")}
            </Btn>
          </div>
        </>
      )}
    </SectionCard>
  );
}

/** The volume-data paragraph (empty volumes, streaming DATA with the migrator) is about what moves to another server. With nothing placed in
 *  place it stays as the hub wrote it; with some, it shows only while a moved app can still carry volume data. */
function movedHasVolumeData(moved: ImportPlan, someStay: boolean): boolean {
  if (!someStay) return true;
  if (!moved.items.some((i) => i.kind === "app")) return false;
  const rows = moved.preflight?.volumes;
  return rows === undefined || rows.length > 0;
}

/** What the preview says for the source servers that stay on their own machine: the data stays where it is. */
function InPlaceDataNote({ stays }: { stays: SourceServerRow[] }) {
  const t = useT();
  return (
    <div data-testid="in-place-data" role="note" style={{ marginTop: 14, fontSize: 12, color: "var(--c-tx2)", lineHeight: 1.5 }}>
      <p style={{ margin: 0 }}>
        <strong>{t("import.inPlaceData.title")}</strong> {t("import.inPlaceData.body")}
      </p>
      <ul style={{ margin: "6px 0 0", paddingLeft: 18, color: "var(--c-tx3)" }}>
        {stays.map((r) => (
          <li key={r.ref}>
            <span className="mono">{r.name ?? r.ref}</span> — {t("import.inPlaceData.counts", { apps: String(r.apps), databases: String(r.databases), services: String(r.services) })}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** PostgreSQL databases may be copied as a data DIRECTORY (volume copy) instead of a logical dump. Choosing it re-plans (the
 *  planHash then covers the choice), locks the target to the source image/major/names and says why. */
function DbDataModes({ plan, modes, busy, onChange }: { plan: ImportPlan; modes: Record<string, "volume">; busy: boolean; onChange: (next: Record<string, "volume">) => void }) {
  const t = useT();
  const cands = volumeCopyCandidates(plan);
  if (cands.length === 0) return null;
  const set = (ref: string, volume: boolean) => {
    const next = { ...modes };
    if (volume) next[ref] = "volume";
    else delete next[ref];
    onChange(next);
  };
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 6 }}>{t("import.vx.mode.label")}</div>
      <ul data-testid="data-mode-tradeoff" style={{ margin: "0 0 8px", paddingLeft: 18, fontSize: 12, color: "var(--c-tx2)", lineHeight: 1.5 }}>
        <li>{t("import.vx.mode.dumpHint")}</li>
        <li>{t("import.vx.mode.volumeHint")}</li>
      </ul>
      <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 8 }}>
        {cands.map((it) => {
          const volume = it.proposed.dataMode === "volume";
          return (
            <li key={it.itemRef} style={{ fontSize: 12 }}>
              <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
                <span className="mono" style={{ minWidth: 100 }}>{it.name}</span>
                <div role="radiogroup" aria-label={`${t("import.vx.mode.label")}: ${it.name}`} style={{ display: "flex", gap: 6 }}>
                  {([false, true] as const).map((isVol) => (
                    <button
                      key={String(isVol)}
                      type="button"
                      role="radio"
                      aria-checked={volume === isVol}
                      disabled={busy}
                      onClick={() => volume !== isVol && set(it.itemRef, isVol)}
                      style={{ fontFamily: "inherit", fontSize: 12, padding: "4px 10px", borderRadius: "var(--r1)", border: "1px solid var(--c-bd)", cursor: busy ? "not-allowed" : "pointer", background: volume === isVol ? "var(--c-a)" : "var(--c-el)", color: volume === isVol ? "var(--c-on-a)" : "var(--c-tx)" }}
                    >
                      {isVol ? t("import.vx.mode.volume") : t("import.vx.mode.dump")}
                    </button>
                  ))}
                </div>
                {busy && <span style={{ color: "var(--c-tx3)" }}>{t("import.vx.mode.replanning")}</span>}
              </div>
              {volume && (
                <p style={{ margin: "4px 0 0", color: "var(--c-am)" }}>
                  {t("import.vx.mode.volumeLocked")}
                  {typeof it.proposed.image === "string" && it.proposed.image ? ` ${it.proposed.image}` : ""}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Post-import step 2 — env remap: preview the (secret-masked) rewrites that point each migrated app at its new
 *  Tugra database, then apply (confirm-gated by the planHash) or undo. Pure wiring over the importer API. */
function RemapEnvCard({ opId, sourceKind = "coolify" }: { opId: string; sourceKind?: ImportRemoteKind }) {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const [plan, setPlan] = useState<ImportRemapPlan | null>(null);
  const [result, setResult] = useState<ImportRemapResult | null>(null);
  const preview = useMutation({
    mutationFn: () => api.remapEnvPlan(opId),
    onSuccess: (p) => { setPlan(p); setResult(null); },
    onError: (e) => toast((e as Error).message, "error"),
  });
  const apply = useMutation({
    mutationFn: (hash: string) => api.remapEnvApply(opId, hash),
    onSuccess: (r) => { setResult(r); setPlan(null); toast(t("import.remapApplied"), "success"); },
    onError: (e) => toast((e as Error).message, "error"),
  });
  const undo = useMutation({
    mutationFn: () => api.remapEnvUndo(opId),
    onSuccess: (r) => { setResult(r); toast(t("import.remapUndone"), "success"); },
    onError: (e) => toast((e as Error).message, "error"),
  });
  const onApply = async () => {
    if (!plan) return;
    const ok = await confirm({ title: t("import.remapApplyTitle"), body: t("import.remapApplyBody") });
    if (ok) apply.mutate(plan.planHash);
  };
  const changeCount = plan?.apps.reduce((n, a) => n + a.changes.length, 0) ?? 0;
  const manualCount = plan?.apps.reduce((n, a) => n + a.needsManual.length, 0) ?? 0;
  return (
    <SectionCard title={t("import.remapTitle")} desc={t("import.remapDesc", { source: t(SRC[sourceKind].name) })} style={{ padding: 20, maxWidth: 720, marginTop: 16, marginBottom: 0 }}>

      {!plan && !result && (
        <Btn onClick={() => preview.mutate()} loading={preview.isPending}>{preview.isPending ? t("import.remapPreviewing") : t("import.remapPreview")}</Btn>
      )}

      {plan && !result && (
        <>
          <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 10 }}>
            {t("import.remapSummary", { apps: plan.apps.length, changes: changeCount })}
            {manualCount > 0 ? ` · ${t("import.remapManual", { n: manualCount })}` : ""}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 12 }}>
            {plan.apps.map((a) => (
              <div key={a.appId} style={{ border: "1px solid var(--c-bd)", borderRadius: 8, padding: 10 }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{a.name}</div>
                {a.changes.map((c) => (
                  <div key={c.key} style={{ fontSize: 11, color: "var(--c-tx3)", marginTop: 4, wordBreak: "break-all" }}>
                    <span className="mono">{c.key}</span>: <span style={{ color: "var(--c-tx2)" }}>{c.oldMasked}</span> → <span style={{ color: "var(--c-g)" }}>{c.newMasked}</span>
                  </div>
                ))}
                {a.needsManual.map((m) => (
                  <div key={m.key} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--c-am)", marginTop: 4 }}><TriangleAlert size={12} aria-hidden style={{ flexShrink: 0 }} /> <span className="mono">{m.key}</span> — {m.reason === "service-link-review" ? t("import.remap.serviceLinkReview") : m.reason === "unresolved-uuid-host" ? t("import.remap.unresolvedHost") : m.reason}</div>
                ))}
                {a.dbNetwork && (
                  <div style={{ fontSize: 11, color: a.dbNetwork.willLink ? "var(--c-g)" : "var(--c-am)", marginTop: 4 }}>
                    {a.dbNetwork.willLink ? t("import.remapWillLink") : t("import.remapNoLink", { reason: a.dbNetwork.reason ?? "" })}
                  </div>
                )}
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Btn onClick={onApply} loading={apply.isPending} disabled={changeCount === 0}>{apply.isPending ? t("import.applying") : t("import.remapApply")}</Btn>
            <Btn variant="ghost" onClick={() => setPlan(null)} disabled={apply.isPending}>{t("import.remapDiscard")}</Btn>
          </div>
        </>
      )}

      {result && (
        <>
          <div style={{ fontSize: 12, color: "var(--c-tx2)", marginBottom: 10, lineHeight: 1.5 }}>{result.note}</div>
          <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 12 }}>
            {t("import.remapResult", { n: result.apps.length })}{result.failed.length > 0 ? ` · ${t("import.remapResultFailed", { n: result.failed.length })}` : ""}
          </div>
          {result.applied && (
            <Btn variant="ghost" onClick={() => undo.mutate()} loading={undo.isPending}>{undo.isPending ? t("import.remapUndoing") : t("import.remapUndo")}</Btn>
          )}
        </>
      )}
    </SectionCard>
  );
}

/** "What isn't carried over": per app, the fields the source has that Tugra does not carry (field names + fixed reasons,
 *  never values). Collapsed by default; a Review row is marked by a text prefix as well as colour. */
function CoverageCard({ plan }: { plan: ImportPlan }) {
  const t = useT();
  const apps = coverageApps(plan);
  if (apps.length === 0) return null;
  const counts = coverageCounts(plan);
  return (
    <SectionCard title={t("import.coverageTitle")} style={{ padding: 16, marginBottom: 0 }}>
      <details>
        <summary style={{ cursor: "pointer", fontSize: 12, color: counts.warn > 0 ? "var(--c-am)" : "var(--c-tx3)" }}>
          {t("import.notCarriedCount", { n: counts.warn + counts.info })}
        </summary>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 10 }}>
          {apps.map((a) => (
            <div key={a.itemRef}>
              <div className="mono" style={{ fontSize: 13, fontWeight: 600, wordBreak: "break-all" }}>{a.name}</div>
              <ul style={{ margin: "4px 0 0", paddingLeft: 16, fontSize: 11 }}>
                {a.notCarried.map((n) => (
                  <li key={n.field} style={{ color: n.level === "warn" ? "var(--c-am)" : "var(--c-tx3)", wordBreak: "break-word" }}>
                    <strong>{n.level === "warn" ? t("import.coverageWarn") : t("import.coverageInfo")}</strong>{" "}
                    <span className="mono" style={{ wordBreak: "break-all" }}>{n.field}</span>: {reasonText(t, n)}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        {hasDeferredCoverage(plan) && <p style={{ fontSize: 11, color: "var(--c-tx3)", margin: "10px 0 0" }}>{t("import.coverageDeferred")}</p>}
      </details>
    </SectionCard>
  );
}

const STEP_KEY: Record<string, string> = {
  prepare: "import.services.steps.prepare",
  create: "import.services.steps.create",
  domains: "import.services.steps.domains",
  "config-files": "import.services.steps.config-files",
  volumes: "import.services.steps.volumes",
  done: "import.services.steps.done",
};

/** An applied service task: its members, config files, private network, what it could not carry, and the post-import
 *  checklist (what to do before the stopped app is deployed). Names and fixed reasons only. */
function ServiceTaskDetails({ task }: { task: ImportOpTask }) {
  const t = useT();
  const sv = task.service;
  if (!sv) return null;
  const name = task.name ?? task.itemRef ?? "";
  const unmapped = [...sv.dropped, ...sv.serviceDomains.unmapped];
  return (
    <div style={{ flexBasis: "100%", paddingLeft: 98, color: "var(--c-tx3)" }}>
      {sv.steps.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 2 }}>
          {sv.steps.map((st) => (
            <span key={st.name} style={{ color: st.status === "FAILED" ? "var(--c-r)" : st.status === "DONE" ? "var(--c-g)" : "var(--c-tx3)" }}>
              {STEP_KEY[st.name] ? t(STEP_KEY[st.name]) : st.name}
            </span>
          ))}
        </div>
      )}
      <div>{t("import.services.timeline.members", { list: sv.members.join(", ") })}</div>
      {sv.configMounts > 0 && <div>{t("import.services.timeline.configMounts", { n: sv.configMounts })}</div>}
      {sv.privateNetwork && <div>{t("import.services.timeline.network", { network: sv.privateNetwork.network, alias: sv.privateNetwork.alias })}</div>}
      {unmapped.length > 0 && (
        <details>
          <summary style={{ cursor: "pointer" }}>{t("import.notCarriedCount", { n: unmapped.length })}</summary>
          <ul style={{ margin: "4px 0 0", paddingLeft: 16 }}>
            {unmapped.map((u, i) => (
              <li key={`${u.field}-${i}`} style={{ wordBreak: "break-word" }}>
                <span className="mono" style={{ wordBreak: "break-all" }}>{u.field}</span>: {u.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
      <ImportChecklist name={name} items={sv.checklist} />
    </div>
  );
}

/** The per-app "Not carried (n)" disclosure of an apply timeline row (postCreate + ingress). Null when nothing is unmapped. */
function TaskNotCarried({ task }: { task: ImportOpTask }) {
  const t = useT();
  const unmapped = [...(task.postCreate?.unmapped ?? []), ...(task.ingress?.unmapped ?? [])];
  if (unmapped.length === 0) return null;
  const applied = [...(task.postCreate?.applied ?? []), ...(task.ingress?.applied ?? [])];
  return (
    <details style={{ flexBasis: "100%", paddingLeft: 98, color: "var(--c-tx3)" }}>
      <summary style={{ cursor: "pointer" }}>{t("import.notCarriedCount", { n: unmapped.length })}</summary>
      <ul style={{ margin: "4px 0 0", paddingLeft: 16 }}>
        {unmapped.map((u, i) => (
          <li key={`${u.field}-${i}`} style={{ wordBreak: "break-word" }}>
            <span className="mono" style={{ wordBreak: "break-all" }}>{u.field}</span>: {reasonText(t, u)}
          </li>
        ))}
      </ul>
      {applied.length > 0 && <div style={{ marginTop: 4 }}>{t("import.appliedList", { list: applied.join(", ") })}</div>}
    </details>
  );
}

function Section({ title, items }: { title: string; items: ImportPlanItem[] }) {
  const t = useT();
  return (
    <Card style={{ padding: 16 }}>
      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 10 }}>
        {title} <span style={{ color: "var(--c-tx3)", fontWeight: 400 }}>({items.length})</span>
      </div>
      {items.length === 0 ? (
        <EmptyState>{t("import.none")}</EmptyState>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {items.map((it) => (
            <ItemRow key={it.itemRef} item={it} />
          ))}
        </div>
      )}
    </Card>
  );
}

function ItemRow({ item }: { item: ImportPlanItem }) {
  return (
    <div style={{ borderBottom: "1px solid var(--c-bd)", paddingBottom: 8 }}>
      <span className="mono" style={{ fontSize: 13, wordBreak: "break-all" }}>{item.name}</span>
      {item.risks.length > 0 && (
        <ul style={{ margin: "4px 0 0", paddingLeft: 16, fontSize: 11 }}>
          {item.risks.map((r, i) => (
            <li key={i} style={{ color: toneColor[riskTone(r.level as ImportRiskLevel)] }}>{r.message}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Stat({ label: lbl, value, danger }: { label: string; value: number; danger?: boolean }) {
  return (
    <div style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: "8px 14px", minWidth: 80 }}>
      <div style={{ fontSize: 20, fontWeight: 600, color: danger ? "var(--c-r)" : "var(--c-tx)" }}>{value}</div>
      <div style={{ fontSize: 11, color: "var(--c-tx3)" }}>{lbl}</div>
    </div>
  );
}

const label: React.CSSProperties = { display: "block", fontSize: 12, color: "var(--c-tx3)", margin: "0 0 4px" };
const field: React.CSSProperties = {
  width: "100%",
  padding: "7px 9px",
  fontSize: 13,
  background: "var(--c-el)",
  border: "1px solid var(--c-bd)",
  borderRadius: "var(--r1)",
  color: "var(--c-tx)",
  marginBottom: 12,
  fontFamily: "inherit",
};
