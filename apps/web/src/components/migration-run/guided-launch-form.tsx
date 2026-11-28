"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useT } from "../../i18n/provider";
import { Btn, SectionCard, Working } from "../ui";
import { BlockedNote } from "../cta-parts";
import { blockTag, serverBlock, type CtaBlock } from "../../lib/cta-readiness";
import { Checkbox, Field, NumberInput, Select, TextInput } from "../form";
import { useToast } from "../toast";
import {
  EMPTY_POLICIES,
  HOST_LOOP_FORM_DEFAULTS,
  MODE_HINT_KEY,
  MODE_KEY,
  TOPOLOGY_HINT_KEY,
  TOPOLOGY_KEY,
  buildLaunchInput,
  errorText,
  launchIssues,
  looksLikeEmail,
  campaignReportHref,
  sourceServersOf,
} from "../../lib/migration-run";
import { AdvancedFields, type AdvancedState } from "./launch-advanced";
import { PlacementFields } from "./launch-placement";
import { AgentGapNotice } from "./agent-gap-notice";
import { TakeoverStartNote, useTakeoverStartBlock } from "../takeover-start-guard";
import { sourceAgentGapsOf } from "../../lib/coolify-ssh";
import { CampaignPreviewCard } from "./launch-campaign";
import { BusyNote, FreshnessNote, SameHostNote, SwapBlockNote } from "./launch-guard-notes";
import { busyServers, copyOntoSourceHost, freshnessOf, freshnessOfError, involvedRefs, swapProxyBlock } from "../../lib/launch-guards";
import { clearImportResume } from "../../lib/import-resume";
import { campaignBody, campaignGuide, campaignOpenHref, campaignsOf, needsCampaign, placementsOf, pruneRebuild, runsByWave, sourcesOfRun } from "../../lib/campaign";
import { LaunchProgress } from "./launch-progress";
import { clearLaunchHandoff } from "../../lib/launch-handoff";
import { HelpLink } from "../help-link";
import { scopePayload, type ImportScope, inPlaceCount, overallPlacement, involvedHosts } from "../../lib/import-scope";
import type { ImportApplyExtras, ImportPlan, ImportRemoteKind, MigrationRunMode, MigrationRunServerMap, MigrationRunTopology } from "../../lib/types";

/** A server the run may land on: what the launcher needs to say, before the click, that one cannot take it. */
type LaunchServer = { id: string; name: string; teamId: string; status?: "PENDING" | "ONLINE" | "OFFLINE"; capabilities?: string[]; canWrite?: boolean };

/** The run's target (and every placement target) runs the deploy and database steps through its agent. */
const RUN_CAPS = ["deploy", "database"] as const;
const blockOf = (s: LaunchServer | undefined): CtaBlock | null => (s && s.status !== undefined && s.capabilities !== undefined ? serverBlock({ status: s.status, canWrite: true, capabilities: s.capabilities }, RUN_CAPS, { write: false }) : null);

export interface GuidedLaunchFormProps {
  plan: ImportPlan;
  kind: ImportRemoteKind;
  sessionId: string;
  servers: LaunchServer[];
  /** Team names, so a campaign per team is headed by its team (absent = the preview numbers them). */
  teams?: ReadonlyArray<{ id: string; name: string }>;
  extras: ImportApplyExtras;
  /** The import's first step: when it narrowed the move, the run carries it, so it moves exactly what was chosen. */
  scope?: ImportScope | null;
  /** Back to the import's first step (the "Change" link of the summary). */
  onChangeScope?: () => void;
  /** Read the source again (the plan the owner reviewed is no longer what the source says). */
  onRecheck?: () => void;
  /** Where "Back" goes (the preview). */
  backHref?: string;
}

/** The guided move's launch PAGE (not a modal): it shows only what applies to the owner's choice. A same-machine takeover asks for the
 *  servers, the certificate email and the observe window; everything about copying data to another server sits in its own section and
 *  appears only when some server really moves. One primary action at the bottom creates the runs and starts the first one, and the
 *  page then shows each run being made. A dry run is the default only when something is copied. */
export function GuidedLaunchForm({ plan, kind, sessionId, servers, teams, extras, scope, onChangeScope, onRecheck, backHref = "/import" }: GuidedLaunchFormProps) {
  const t = useT();
  const toast = useToast();
  const router = useRouter();
  const qc = useQueryClient();
  const [phase, setPhase] = useState<"form" | "creating" | "starting">("form");
  const submittedAt = useRef(0);
  // a campaign that failed partway: how many of its runs the hub had already made, so the owner is not left with an unexplained form
  const [partial, setPartial] = useState<{ made: number; total: number } | null>(null);
  const madeRef = useRef(0);
  // The run starts from what the first step chose, narrowed or not: its target, and its placement when it used several servers.
  const chosenTarget = scope && servers.some((s) => s.id === scope.defaultServerId) ? scope.defaultServerId : "";
  // Without a first-step choice, the first server that can take the run, never one that is offline or lacks the capabilities.
  const fallbackTarget = servers.find((s) => !blockOf(s))?.id ?? "";
  const [targetServerId, setTarget] = useState(chosenTarget || fallbackTarget);
  // Same-machine servers only (Coolify): nothing is copied, so a dry run is not the way in: every step is gated and nothing touches traffic before the owner approves.
  const onlyInPlace = kind === "coolify" && overallPlacement(scope) === "in-place";
  const [dryRun, setDryRun] = useState(!onlyInPlace);
  const [mode, setMode] = useState<MigrationRunMode>("copy");
  // In place (same machine, proxy swap) is only for Coolify, and only when the first step says every source is on its own target.
  const [topology, setTopology] = useState<MigrationRunTopology>(kind === "coolify" && overallPlacement(scope) === "in-place" ? "swap-proxy" : "two-box");
  const [acmeEmail, setAcmeEmailRaw] = useState("");
  const emailTouched = useRef(false);
  const setAcmeEmail = (v: string) => {
    emailTouched.current = true;
    setAcmeEmailRaw(v);
  };
  // The instance's certificate email, when the person may read it, fills the field until they type their own.
  const instance = useQuery({ queryKey: ["instance-settings"], queryFn: () => api.getInstanceSettings(), retry: false, staleTime: 60_000 });
  const knownEmail = instance.data?.acmeEmail || instance.data?.suggested?.acmeEmail || "";
  useEffect(() => {
    if (knownEmail && !emailTouched.current) setAcmeEmailRaw(knownEmail);
  }, [knownEmail]);
  const [controller, setController] = useState<"manual" | "api" | "agent">("manual");
  const [allowBind, setAllowBind] = useState(false);
  const [probe, setProbe] = useState(false);
  const [observe, setObserve] = useState("30");
  const [placement, setPlacement] = useState<MigrationRunServerMap | null>(chosenTarget && scope?.serverMap ? { ...scope.serverMap } : null);
  const [adv, setAdv] = useState<AdvancedState>({
    // a move through a campaign is named by default, so its report reads as what it is instead of a random label
    campaign: kind === "coolify" && needsCampaign(scope) ? t("migrationRun.launch.page.defaultName", { when: new Date().toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) }) : "",
    sourceRunner: "operator",
    hostLoop: { ...HOST_LOOP_FORM_DEFAULTS },
    deployWaves: "single",
    deployConcurrency: "",
    largeDbMode: "stream-logical",
    serviceStart: "dependencies",
    stopSource: false,
    policies: { ...EMPTY_POLICIES },
  });

  // Only servers of the target's team can take part in the run (the hub refuses another team's server).
  const teamId = servers.find((s) => s.id === targetServerId)?.teamId;
  const placeable = useMemo(() => servers.filter((s) => !teamId || s.teamId === teamId), [servers, teamId]);
  // A run chosen in the first step stays in that step's team; to use another team, go back and change it.
  const targetChoices = scope && chosenTarget ? placeable : servers;
  // a server that already carries a live guided migration cannot take another one (the hub refuses it at create)
  const live = useQuery({ queryKey: ["migration-runs", "live-targets", teamId ?? ""], queryFn: () => api.listMigrationRuns({ teamId, active: true, limit: 100 }), enabled: !!teamId, staleTime: 15_000, retry: false });
  const busy = useMemo(() => busyServers(live.data), [live.data]);
  const tagOf = (s: LaunchServer): string | null => {
    const b = blockOf(s);
    return b ? blockTag(t, b) : busy.has(s.id) ? t("migrationRun.launch.guard.busyTag") : null;
  };
  const targetOptions = targetChoices.map((s) => {
    const tag = tagOf(s);
    return { value: s.id, label: tag ? `${s.name} (${tag})` : s.name, disabled: !!tag && s.id !== targetServerId };
  });
  const placeableOptions = placeable.map((s) => {
    const tag = tagOf(s);
    return { id: s.id, name: tag ? `${s.name} (${tag})` : s.name };
  });
  // Same-machine and copied moves together, several same-machine servers, or servers of several teams: the hub makes a campaign of runs (one per team, then
  // one per same-machine server and one for the rest), so the target, the topology and the placement are its to decide and are not asked here.
  const campaign = kind === "coolify" && needsCampaign(scope);
  // every server the run would use must be able to take it (a campaign uses the servers the first step placed)
  const used = [...new Set((campaign ? Object.values(scope?.placed ?? {}) : [targetServerId, ...Object.values(placement ?? {})]).filter(Boolean))];
  const blockedUsed = used.flatMap((id) => {
    const b = blockOf(servers.find((s) => s.id === id));
    return b ? [{ id, name: servers.find((s) => s.id === id)?.name ?? id, block: b }] : [];
  });
  // the summary of the first step's choice
  const counts = useMemo(() => {
    const c = { apps: 0, databases: 0, services: 0 };
    for (const it of plan.items) {
      if (scope && !scope.inScope.has(it.itemRef)) continue;
      if (it.kind === "app") c.apps += 1;
      else if (it.kind === "database") c.databases += 1;
      else if (it.kind === "service") c.services += 1;
    }
    return c;
  }, [plan.items, scope]);
  const targetNames = [...new Set([targetServerId, ...Object.values(placement ?? {})].map((id) => servers.find((s) => s.id === id)?.name).filter(Boolean))] as string[];
  const sourceRows = useMemo(() => sourceServersOf(plan.items ?? [], plan.preflight?.hosts), [plan.items, plan.preflight?.hosts]);
  // A move needs an agent on both ends: the source servers it takes something from that have none (Coolify; the hub refuses a real run too).
  const agentGaps = useMemo(() => {
    if (kind !== "coolify") return [];
    const used = new Set(sourceRows.filter((r) => r.apps + r.databases + r.services > 0 && (!scope || involvedHosts(plan, scope.inScope).some((h) => h.ref === r.ref))).map((r) => r.ref));
    return sourceAgentGapsOf(plan.preflight?.hosts, used);
  }, [kind, plan, scope, sourceRows]);
  const changeTarget = (id: string) => {
    // a host that was on the old default follows the new default; hosts the operator moved elsewhere stay where they are
    if (placement) setPlacement(Object.fromEntries(Object.entries(placement).map(([ref, sid]) => [ref, sid === targetServerId ? id : sid])));
    setTarget(id);
  };

  const form = {
    sessionId, sourceKind: kind, targetServerId, planHash: plan.planHash, extras, mode, topology, dryRun, acmeEmail, allowBind, allowLiveShapeProbe: probe, sourceController: controller, observeMinutes: observe,
    placement, scope: scopePayload(scope), campaign: adv.campaign, sourceRunner: adv.sourceRunner, hostLoop: adv.hostLoop, deployWaves: adv.deployWaves, deployConcurrency: adv.deployConcurrency, largeDbMode: adv.largeDbMode, serviceStart: adv.serviceStart, stopSource: adv.stopSource, policies: adv.policies,
  };
  const issues = launchIssues(form).filter((i) => !(campaign && i === "target"));
  const placements = useMemo(() => (scope ? placementsOf(scope) : []), [scope]);
  // the plan hash covers the data modes chosen at review, and the hub narrows each run to the first step's pick: the preview is read with both, as the create is
  const dbDataModes = extras.dbDataModes && Object.keys(extras.dbDataModes).length ? extras.dbDataModes : undefined;
  const campaignScope = useMemo(() => scopePayload(scope), [scope]);
  const preview = useQuery({
    queryKey: ["campaign-plan", sessionId, plan.planHash, placements, dbDataModes, campaignScope],
    queryFn: () => api.planCampaign({ sessionId, planHash: plan.planHash, placements: placements.map((p) => ({ sourceServerRef: p.sourceServerRef, kind: p.kind, targetServerId: p.targetServerId ?? null })), ...(dbDataModes ? { dbDataModes } : {}), ...(campaignScope ? { scope: campaignScope } : {}) }),
    enabled: campaign && placements.length > 0,
    retry: false,
  });
  // The apps the owner chose to build with Tugra. Only a same-machine wave of the campaign builds anything; a choice for an app no such wave offers any more
  // (the placement changed) is not sent, so the hub never refuses a stale one.
  const [rebuildChoice, setRebuild] = useState<string[]>([]);
  const rebuild = useMemo(() => (campaign ? pruneRebuild(rebuildChoice, preview.data?.runs, plan.items, scope?.inScope) : []), [campaign, rebuildChoice, preview.data?.runs, plan.items, scope?.inScope]);
  // what the owner chose here cannot work: said at the choice, with the way out, not after the click
  const refs = useMemo(() => involvedRefs(plan, scope), [plan, scope]);
  const swapPossible = swapProxyBlock({ plan, targetId: targetServerId, placement, refs });
  const swapBlock = !campaign && topology === "swap-proxy" ? swapPossible : null;
  const sameHost = !campaign && topology !== "swap-proxy" ? copyOntoSourceHost({ plan, targetId: targetServerId, placement, refs }) : [];
  const sameHostNames = [...new Set(sameHost.map((r) => sourceRows.find((x) => x.ref === r)?.name ?? plan.preflight?.hosts?.find((h) => h.ref === r)?.name ?? r))];
  const campaignTargets = campaign ? placements.flatMap((p) => (p.targetServerId ? [p.targetServerId] : [])) : [];
  const usedBusy = [...new Set([...used, ...campaignTargets])].filter((id) => busy.has(id));
  // the plan and the connection the owner reviewed must still stand; a campaign preview reads them already, a single run re-reads the plan
  const reread = useQuery({
    queryKey: ["launch-fresh", sessionId, plan.planHash],
    queryFn: () => api.importPlan({ sourceKind: kind, sessionId, ...(extras.dbDataModes && Object.keys(extras.dbDataModes).length ? { dbDataModes: extras.dbDataModes } : {}) }),
    enabled: !campaign,
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  const freshness = campaign ? freshnessOfError(preview.error) : freshnessOf(plan.planHash, { hash: reread.data?.planHash, error: reread.error });
  // a same-machine move starts an in-place takeover: a takeover already on the server, or Tugra's own proxy already serving apps there, is refused at its plan
  const takeoverBlock = useTakeoverStartBlock(targetServerId, !campaign && topology === "swap-proxy" && !swapBlock && !!targetServerId, busy.get(targetServerId) ?? null);
  // a server held by a live run already has its own note above
  const takeoverNote = takeoverBlock === "server_busy" && busy.has(targetServerId) ? null : takeoverBlock;
  const guarded = !!swapBlock || sameHost.length > 0 || usedBusy.length > 0 || !!freshness || !!takeoverNote;
  const campaignRefused = campaign && (preview.isLoading || preview.isError || !!preview.data?.failure || !preview.data?.runs);
  // A same-machine run needs the certificate email: the new certificates are asked for after the ports are taken.
  const inPlaceIncluded = campaign && inPlaceCount(scope as ImportScope) >= 1;
  const emailMissing = inPlaceIncluded && !acmeEmail.trim();
  const plannedRuns = useMemo(() => (preview.data?.teams && preview.data.teams.length > 1 ? preview.data.teams.flatMap((tp) => tp.runs) : (preview.data?.runs ?? [])), [preview.data]);
  const runCount = campaign ? plannedRuns.length : 1;
  const runNames = useMemo(() => {
    if (!campaign) return [];
    const nameOf = (ref: string) => sourceRows.find((x) => x.ref === ref)?.name ?? ref;
    return runsByWave(plannedRuns).flatMap((w) => w.runs.map((r) => sourcesOfRun(r).map(nameOf).join(", ")));
  }, [campaign, plannedRuns, sourceRows]);

  // While the hub makes the runs one after the other, the runs of this label that already exist are the progress.
  const label = adv.campaign.trim();
  const made = useQuery({
    queryKey: ["launch-progress", label],
    queryFn: () => api.listMigrationRuns({ campaign: label, limit: 100 }),
    enabled: campaign && phase === "creating" && !!label,
    refetchInterval: 1500,
    retry: false,
    gcTime: 0,
  });
  const madeCount = (made.data ?? []).filter((r) => Date.parse(r.createdAt) >= submittedAt.current - 30_000).length;
  madeRef.current = Math.max(madeRef.current, madeCount);

  const create = useMutation({
    mutationFn: async (): Promise<{ href: string; campaigns: number; startError: unknown }> => {
      const input = buildLaunchInput(form);
      submittedAt.current = Date.now();
      madeRef.current = 0;
      setPartial(null);
      setPhase("creating");
      let startError: unknown = null;
      if (campaign) {
        const c = await api.createCampaign(campaignBody(input, placements, rebuild));
        // one campaign per team, all under one label: the report of the label holds the runs of every one of them
        const views = campaignsOf(c);
        setPhase("starting");
        try {
          // wave 1 of every campaign is started now; the next waves are started one after the other from the campaign page
          const runs = await api.listMigrationRuns({ campaign: c.label, limit: 100 });
          const { next } = campaignGuide(views, runs);
          await Promise.all([...next].map((id) => api.startMigrationRun(id)));
        } catch (e) {
          startError = e;
        }
        return { href: campaignOpenHref(c), campaigns: views.length, startError };
      }
      const run = await api.createMigrationRun(input);
      setPhase("starting");
      try {
        await api.startMigrationRun(run.id);
      } catch (e) {
        startError = e;
      }
      return { href: `/import/runs/${run.id}`, campaigns: 0, startError };
    },
    onSuccess: ({ href, campaigns, startError }) => {
      if (campaigns > 1) toast(t("placement.campaign.createdMany", { count: campaigns }), "success");
      // the runs exist; one that could not be started is said, and started from its page
      if (startError) toast(t("migrationRun.launch.page.startFailed", { reason: errorText(t, startError) }), "error");
      void qc.invalidateQueries({ queryKey: ["migration-runs"] });
      void qc.invalidateQueries({ queryKey: ["migration-campaigns"] });
      clearLaunchHandoff();
      router.push(href);
    },
    onError: async (e) => {
      const total = runCount;
      let madeNow = madeRef.current;
      if (campaign && label) {
        // the hub may have made runs before it failed or timed out: count what exists now, so the message is true
        try {
          const runs = await api.listMigrationRuns({ campaign: label, limit: 100 });
          madeNow = Math.max(madeNow, runs.filter((r) => Date.parse(r.createdAt) >= submittedAt.current - 30_000).length);
        } catch {
          // keep the count seen while it was being made
        }
      }
      setPhase("form");
      if (campaign && madeNow > 0) setPartial({ made: Math.min(madeNow, total), total });
      toast(errorText(t, e), "error");
    },
  });
  const working = create.isPending || create.isSuccess;
  const blocked = issues.length > 0 || emailMissing || servers.length === 0 || blockedUsed.length > 0 || guarded || !!campaignRefused || (!dryRun && agentGaps.length > 0);
  const startText = campaign
    ? dryRun
      ? t(runCount === 1 ? "migrationRun.launch.page.dryOne" : "migrationRun.launch.page.dryMany", { count: runCount })
      : onlyInPlace && runCount === 1
        ? t("migrationRun.launch.page.takeover")
        : runCount > 1
          ? t("placement.campaign.create", { count: runCount })
          : t("migrationRun.launch.page.createStart")
    : dryRun
      ? t("migrationRun.launch.page.dryOne", { count: 1 })
      : t("migrationRun.launch.page.createStart");
  // only wave 1 is started here: said before the click, so the owner knows what starts now and what waits
  const laterWaves = campaign && runCount > 1;
  // why the button is off, in the order the owner can fix it; every cause that turns it off has a line, so the sticky bar is never silent
  const whyOff = !blocked || working
    ? null
    : emailMissing
      ? t("migrationRun.launch.page.whyEmail")
      : issues.length > 0
        ? t("migrationRun.launch.page.whyFields")
        : servers.length === 0 || blockedUsed.length > 0
          ? t("migrationRun.launch.page.whyServer")
          : usedBusy.length > 0
            ? t("migrationRun.launch.page.whyBusy")
            : campaign && preview.isLoading
              ? t("migrationRun.launch.page.whyPreviewLoading")
              : campaignRefused
                ? t("migrationRun.launch.page.whyPreviewFailed")
                : freshness
                  ? t("migrationRun.launch.page.whyChanged")
                  : guarded
                    ? t("migrationRun.launch.page.whyNotes")
                    : !dryRun && agentGaps.length > 0
                      ? t("migrationRun.launch.page.whyAgent")
                      : null;
  const section = { display: "flex", flexDirection: "column", gap: 14, padding: 16, marginBottom: 0 } as const;

  return (
    <form
      data-testid="guided-launch-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!blocked && !working) create.mutate();
      }}
      style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 720 }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <Link href={backHref} className="tg-link" style={{ fontSize: 13 }}>{t("migrationRun.launch.page.back")}</Link>
        <HelpLink guide={topology === "swap-proxy" ? "move-from-coolify-same-server" : "move-from-coolify"} />
      </div>
      <div>
        <h1 style={{ fontSize: 20, fontWeight: 600, margin: "0 0 4px" }}>{onlyInPlace ? t("migrationRun.launch.page.titleInPlace") : t("migrationRun.launch.page.title")}</h1>
        <p style={{ margin: 0, fontSize: 13, color: "var(--c-tx3)", lineHeight: 1.5 }}>{onlyInPlace ? t("migrationRun.launch.page.leadInPlace") : t("migrationRun.launch.dialogDesc")}</p>
      </div>

      {working ? (
        <LaunchProgress names={runNames} done={campaign ? madeCount : 0} phase={phase === "starting" ? "starting" : "creating"} />
      ) : (
        <>
          {partial && (
            <div role="alert" data-testid="launch-partial" style={{ border: "1px solid var(--c-am)", borderRadius: "var(--r2)", padding: 12, fontSize: 13, lineHeight: 1.5, display: "flex", flexDirection: "column", gap: 6 }}>
              <span>{t("migrationRun.launch.page.partial", { made: partial.made, total: partial.total })}</span>
              <Link href={campaignReportHref(label)} className="tg-link">{t("migrationRun.launch.page.partialOpen")}</Link>
            </div>
          )}
          <SectionCard title={t("migrationRun.launch.page.what")} style={section}>
            {scope?.narrowed && (
              <p role="note" style={{ margin: 0, fontSize: 12, color: "var(--c-tx2)", lineHeight: 1.5 }}>
                {t("migrationRun.launch.scoped", { count: plan.items.filter((i) => i.kind === "app" || i.kind === "database" || i.kind === "service").length })}
              </p>
            )}
            {scope && (
              <div role="note" data-testid="launch-summary" style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap", fontSize: 12, color: "var(--c-tx2)", lineHeight: 1.5 }}>
                <span style={{ flex: "1 1 240px" }}>
                  {t("migrationRun.launch.summary", { targets: targetNames.join(", ") || "-", apps: counts.apps, databases: counts.databases, services: counts.services })}{" "}
                  {overallPlacement(scope) === "in-place" ? t("migrationRun.launch.sameMachine") : t("migrationRun.launch.otherServer")}
                </span>
                {onChangeScope && <Btn variant="ghost" onClick={onChangeScope}>{t("import.scope.change")}</Btn>}
              </div>
            )}

            {campaign && (
              <Field label={t("migrationRun.launch.page.name")} hint={t("migrationRun.launch.page.nameHint")} error={issues.includes("campaign") ? t("migrationRun.launch.advanced.campaignInvalid") : undefined}>
                <TextInput value={adv.campaign} onChange={(e) => setAdv({ ...adv, campaign: e.target.value })} maxLength={80} autoComplete="off" style={{ minHeight: 44 }} />
              </Field>
            )}

            {/* a campaign takes the servers the first step placed: nothing to choose here a second time */}
            {!campaign && (
              <Field label={t("migrationRun.launch.target")} hint={t("migrationRun.launch.targetHint")} error={issues.includes("target") ? t("migrationRun.launch.targetMissing") : undefined}>
                <Select value={targetServerId} onChange={changeTarget} options={targetOptions} style={{ minHeight: 44 }} />
              </Field>
            )}
            {blockedUsed.map((b) => (
              <p key={b.id} style={{ margin: 0 }}>
                <strong style={{ fontSize: 12 }}>{b.name}: </strong>
                <BlockedNote block={b.block} serverId={b.id} />
              </p>
            ))}
            {usedBusy.map((id) => (
              <BusyNote key={id} name={servers.find((s) => s.id === id)?.name ?? id} runId={busy.get(id) as string} />
            ))}
            {takeoverNote && <TakeoverStartNote block={takeoverNote} serverId={targetServerId} />}
            {freshness && <FreshnessNote freshness={freshness} onRead={() => onRecheck?.()} onConnect={() => { clearImportResume(); clearLaunchHandoff(); router.push(backHref); }} />}
            {((!!teamId && live.isFetching && !live.data) || (!campaign && reread.isFetching && !reread.data)) && <Working text={t("migrationRun.launch.checking")} />}
            <AgentGapNotice gaps={agentGaps} dryRun={dryRun} />

            {campaign ? (
              <CampaignPreviewCard inPlaceOnly={onlyInPlace} preview={preview.data ?? null} loading={preview.isLoading} failed={preview.isError} rows={sourceRows} servers={servers} items={plan.items} inScope={scope?.inScope} rebuild={rebuild} onRebuild={setRebuild} disabled={create.isPending} teams={teams} />
            ) : (
              <PlacementFields rows={sourceRows} servers={placeableOptions} defaultId={targetServerId} value={placement} onChange={setPlacement} invalid={issues.includes("placement")} />
            )}
          </SectionCard>

          <SectionCard title={t("migrationRun.launch.page.before")} style={section}>
            <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))" }}>
              <Field
                label={t("migrationRun.inputs.acmeEmail")}
                hint={inPlaceIncluded ? t("migrationRun.launch.page.emailHint") : t("migrationRun.launch.acmeHint")}
                error={acmeEmail.trim() && !looksLikeEmail(acmeEmail) ? t("migrationRun.inputs.emailInvalid") : emailMissing ? t("migrationRun.launch.page.emailRequired") : undefined}
              >
                <TextInput type="email" value={acmeEmail} onChange={(e) => setAcmeEmail(e.target.value)} autoComplete="off" required={inPlaceIncluded} style={{ minHeight: 44 }} />
              </Field>
              <Field label={t("migrationRun.launch.observe")} hint={t("migrationRun.launch.observeHint")} error={issues.includes("observe") ? t("migrationRun.launch.observeInvalid") : undefined}>
                <NumberInput min={0} max={4320} value={observe} onChange={(e) => setObserve(e.target.value)} style={{ minHeight: 44 }} />
              </Field>
            </div>
            <div>
              <Checkbox checked={dryRun} onChange={setDryRun} label={t("migrationRun.launch.dryRun")} />
              <div style={{ fontSize: 11, color: "var(--c-tx3)", margin: "2px 0 0 24px", lineHeight: 1.5 }}>{onlyInPlace ? t("migrationRun.launch.page.dryRunHintInPlace") : t("migrationRun.launch.dryRunHint")}</div>
            </div>
          </SectionCard>

          {!onlyInPlace && (
            <SectionCard title={campaign ? t("migrationRun.launch.page.moves") : t("migrationRun.launch.page.moveSettings")} desc={t("migrationRun.launch.page.movesHint")} style={section}>
              <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))" }}>
                <Field label={t("migrationRun.launch.mode")} hint={t(MODE_HINT_KEY[mode])}>
                  <Select value={mode} onChange={(v) => setMode(v as MigrationRunMode)} options={(["copy", "takeover"] as const).map((m) => ({ value: m, label: t(MODE_KEY[m]) }))} style={{ minHeight: 44 }} />
                </Field>
                {!campaign && (
                  <Field label={t("migrationRun.launch.topology")} hint={t(TOPOLOGY_HINT_KEY[topology])}>
                    <Select value={topology} onChange={(v) => setTopology(v as MigrationRunTopology)} options={(kind === "coolify" ? (["two-box", "swap-proxy"] as const) : (["two-box"] as const)).map((m) => {
                      const off = m === "swap-proxy" && !!swapPossible && topology !== m;
                      return { value: m, label: off ? `${t(TOPOLOGY_KEY[m])} (${t("migrationRun.launch.guard.notHere")})` : t(TOPOLOGY_KEY[m]), disabled: off };
                    })} style={{ minHeight: 44 }} />
                  </Field>
                )}
                <Field label={t("migrationRun.inputs.sourceController")} hint={t("migrationRun.inputs.sourceControllerHint")}>
                  <Select
                    value={controller}
                    onChange={(v) => setController(v as "manual" | "api" | "agent")}
                    options={[
                      { value: "manual", label: t("migrationRun.inputs.controller.manual") },
                      { value: "api", label: t("migrationRun.inputs.controller.api") },
                      { value: "agent", label: t("migrationRun.inputs.controller.agent") },
                    ]}
                    style={{ minHeight: 44 }}
                  />
                </Field>
              </div>
              {swapBlock && <SwapBlockNote block={swapBlock} onUseOther={() => setTopology("two-box")} disabled={create.isPending} />}
              {sameHost.length > 0 && <SameHostNote names={sameHostNames} />}
              <Checkbox checked={allowBind} onChange={setAllowBind} label={t("migrationRun.inputs.allowBind")} />
              <Checkbox checked={probe} onChange={setProbe} label={t("migrationRun.inputs.allowLiveShapeProbe")} />
              <AdvancedFields value={adv} onChange={setAdv} issues={issues} hideCampaign={campaign} />
            </SectionCard>
          )}
        </>
      )}

      {/* the one primary action of the page, pinned to the bottom so it is in reach wherever the owner stopped reading */}
      <div data-testid="launch-actions" style={{ position: "sticky", bottom: 0, zIndex: 5, display: "flex", flexDirection: "column", gap: 6, padding: "10px 0 calc(10px + env(safe-area-inset-bottom, 0px))", background: "var(--c-sb)", borderTop: "1px solid var(--c-bd)" }}>
        {laterWaves && !working && <p data-testid="launch-waves-note" style={{ margin: 0, fontSize: 12, color: "var(--c-tx3)", lineHeight: 1.5 }}>{t("migrationRun.launch.page.wavesNote")}</p>}
        {whyOff && <p role="status" data-testid="launch-why" style={{ margin: 0, fontSize: 12, color: "var(--c-am)", lineHeight: 1.5 }}>{whyOff}</p>}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Btn type="submit" disabled={blocked || working} loading={working} style={{ minHeight: 44, flex: "1 1 220px", justifyContent: "center" }}>
            {startText}
          </Btn>
          {!working && (
            <Link href={backHref} className="tg-link" style={{ alignSelf: "center", fontSize: 13, padding: "0 8px" }}>{t("common.cancel")}</Link>
          )}
        </div>
      </div>
    </form>
  );
}
