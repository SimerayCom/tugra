"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Route } from "lucide-react";
import { api } from "../../lib/api";
import { useT } from "../../i18n/provider";
import { Btn } from "../ui";
import { Modal } from "../modal";
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
  sourceServersOf,
} from "../../lib/migration-run";
import { AdvancedFields, type AdvancedState } from "./launch-advanced";
import { PlacementFields } from "./launch-placement";
import { AgentGapNotice } from "./agent-gap-notice";
import { sourceAgentGapsOf } from "../../lib/coolify-ssh";
import { CampaignPreviewCard } from "./launch-campaign";
import { campaignBody, campaignOpenHref, campaignsOf, needsCampaign, placementsOf, pruneRebuild } from "../../lib/campaign";
import { HelpLink } from "../help-link";
import { scopePayload, type ImportScope, overallPlacement, involvedHosts } from "../../lib/import-scope";
import type { ImportApplyExtras, ImportPlan, ImportRemoteKind, MigrationRunMode, MigrationRunServerMap, MigrationRunTopology } from "../../lib/types";

/** A server the run may land on: what the launcher needs to say, before the click, that one cannot take it. */
type LaunchServer = { id: string; name: string; teamId: string; status?: "PENDING" | "ONLINE" | "OFFLINE"; capabilities?: string[]; canWrite?: boolean };

/** The run's target (and every placement target) runs the deploy and database steps through its agent. */
const RUN_CAPS = ["deploy", "database"] as const;
const blockOf = (s: LaunchServer | undefined): CtaBlock | null => (s && s.status !== undefined && s.capabilities !== undefined ? serverBlock({ status: s.status, canWrite: true, capabilities: s.capabilities }, RUN_CAPS, { write: false }) : null);

interface Props {
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
  disabled?: boolean;
}

/** The wizard's "Run guided migration" entry. It sits next to the manual apply, which stays untouched: the guided run
 *  freezes the same reviewed plan (the plan hash plus the acknowledgements and choices made above), then drives the
 *  whole flow with gates and approvals. A dry-run is the default and writes nothing outside the run's own records. */
export function GuidedRunLauncher(props: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginTop: 18, paddingTop: 16, borderTop: "1px solid var(--c-bd)" }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{t("migrationRun.launch.title")}</div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 10px", lineHeight: 1.5 }}>{t("migrationRun.launch.desc")}</p>
      <Btn variant="ghost" icon={Route} onClick={() => setOpen(true)} disabled={props.disabled}>{t("migrationRun.launch.button")}</Btn>
      {open && <LaunchDialog {...props} onClose={() => setOpen(false)} />}
    </div>
  );
}

function LaunchDialog({ plan, kind, sessionId, servers, teams, extras, scope, onChangeScope, onClose }: Props & { onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const router = useRouter();
  const qc = useQueryClient();
  // The run starts from what the first step chose, narrowed or not: its target, and its placement when it used several servers.
  const chosenTarget = scope && servers.some((s) => s.id === scope.defaultServerId) ? scope.defaultServerId : "";
  // Without a first-step choice, the first server that can take the run, never one that is offline or lacks the capabilities.
  const fallbackTarget = servers.find((s) => !blockOf(s))?.id ?? "";
  const [targetServerId, setTarget] = useState(chosenTarget || fallbackTarget);
  const [dryRun, setDryRun] = useState(true);
  const [mode, setMode] = useState<MigrationRunMode>("copy");
  // In place (same machine, proxy swap) is only for Coolify, and only when the first step says every source is on its own target.
  const [topology, setTopology] = useState<MigrationRunTopology>(kind === "coolify" && overallPlacement(scope) === "in-place" ? "swap-proxy" : "two-box");
  const [acmeEmail, setAcmeEmail] = useState("");
  const [controller, setController] = useState<"manual" | "api" | "agent">("manual");
  const [allowBind, setAllowBind] = useState(false);
  const [probe, setProbe] = useState(false);
  const [observe, setObserve] = useState("30");
  const [placement, setPlacement] = useState<MigrationRunServerMap | null>(chosenTarget && scope?.serverMap ? { ...scope.serverMap } : null);
  const [adv, setAdv] = useState<AdvancedState>({
    campaign: "",
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
  const targetOptions = targetChoices.map((s) => {
    const b = blockOf(s);
    return { value: s.id, label: b ? `${s.name} (${blockTag(t, b)})` : s.name, disabled: !!b && s.id !== targetServerId };
  });
  const placeableOptions = placeable.map((s) => {
    const b = blockOf(s);
    return { id: s.id, name: b ? `${s.name} (${blockTag(t, b)})` : s.name };
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
  const preview = useQuery({
    queryKey: ["campaign-plan", sessionId, plan.planHash, placements],
    queryFn: () => api.planCampaign({ sessionId, planHash: plan.planHash, placements: placements.map((p) => ({ sourceServerRef: p.sourceServerRef, kind: p.kind, targetServerId: p.targetServerId ?? null })) }),
    enabled: campaign && placements.length > 0,
    retry: false,
  });
  // The apps the owner chose to build with Tugra. Only a same-machine wave of the campaign builds anything; a choice for an app no such wave offers any more
  // (the placement changed) is not sent, so the hub never refuses a stale one.
  const [rebuildChoice, setRebuild] = useState<string[]>([]);
  const rebuild = useMemo(() => (campaign ? pruneRebuild(rebuildChoice, preview.data?.runs, plan.items, scope?.inScope) : []), [campaign, rebuildChoice, preview.data?.runs, plan.items, scope?.inScope]);
  const campaignRefused = campaign && (preview.isLoading || preview.isError || !!preview.data?.failure || !preview.data?.runs);
  const create = useMutation({
    mutationFn: async (): Promise<{ href: string; campaigns: number }> => {
      const input = buildLaunchInput(form);
      if (campaign) {
        const c = await api.createCampaign(campaignBody(input, placements, rebuild));
        // one campaign per team, all under one label: the report of the label holds the runs of every one of them
        return { href: campaignOpenHref(c), campaigns: campaignsOf(c).length };
      }
      const run = await api.createMigrationRun(input);
      return { href: `/import/runs/${run.id}`, campaigns: 0 };
    },
    onSuccess: ({ href, campaigns }) => {
      if (campaigns > 1) toast(t("placement.campaign.createdMany", { count: campaigns }), "success");
      void qc.invalidateQueries({ queryKey: ["migration-runs"] });
      void qc.invalidateQueries({ queryKey: ["migration-campaigns"] });
      router.push(href);
    },
    onError: (e) => toast(errorText(t, e), "error"),
  });

  return (
    <Modal onClose={() => !create.isPending && onClose()} ariaLabel={t("migrationRun.launch.title")} width={560} closeOnBackdrop={false}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (issues.length === 0 && !campaignRefused && !create.isPending) create.mutate();
        }}
        style={{ display: "flex", flexDirection: "column", gap: 14 }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <h2 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>{t("migrationRun.launch.title")}</h2>
          <HelpLink guide={topology === "swap-proxy" ? "move-from-coolify-same-server" : "move-from-coolify"} />
        </div>
        <p style={{ margin: 0, fontSize: 12, color: "var(--c-tx3)", lineHeight: 1.5 }}>{t("migrationRun.launch.dialogDesc")}</p>
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
            {onChangeScope && <Btn variant="ghost" onClick={() => { onClose(); onChangeScope(); }} disabled={create.isPending}>{t("import.scope.change")}</Btn>}
          </div>
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

        <AgentGapNotice gaps={agentGaps} dryRun={dryRun} />

        {campaign ? (
          <CampaignPreviewCard preview={preview.data ?? null} loading={preview.isLoading} failed={preview.isError} rows={sourceRows} servers={servers} items={plan.items} inScope={scope?.inScope} rebuild={rebuild} onRebuild={setRebuild} disabled={create.isPending} teams={teams} />
        ) : (
          <PlacementFields rows={sourceRows} servers={placeableOptions} defaultId={targetServerId} value={placement} onChange={setPlacement} invalid={issues.includes("placement")} />
        )}

        <div>
          <Checkbox checked={dryRun} onChange={setDryRun} label={t("migrationRun.launch.dryRun")} />
          <div style={{ fontSize: 11, color: "var(--c-tx3)", margin: "2px 0 0 24px", lineHeight: 1.5 }}>{t("migrationRun.launch.dryRunHint")}</div>
        </div>

        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))" }}>
          <Field label={t("migrationRun.launch.mode")} hint={t(MODE_HINT_KEY[mode])}>
            <Select value={mode} onChange={(v) => setMode(v as MigrationRunMode)} options={(["copy", "takeover"] as const).map((m) => ({ value: m, label: t(MODE_KEY[m]) }))} style={{ minHeight: 44 }} />
          </Field>
          {!campaign && (
            <Field label={t("migrationRun.launch.topology")} hint={t(TOPOLOGY_HINT_KEY[topology])}>
              <Select value={topology} onChange={(v) => setTopology(v as MigrationRunTopology)} options={(kind === "coolify" ? (["two-box", "swap-proxy"] as const) : (["two-box"] as const)).map((m) => ({ value: m, label: t(TOPOLOGY_KEY[m]) }))} style={{ minHeight: 44 }} />
            </Field>
          )}
        </div>

        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))" }}>
          <Field label={t("migrationRun.inputs.acmeEmail")} hint={t("migrationRun.launch.acmeHint")} error={acmeEmail.trim() && !looksLikeEmail(acmeEmail) ? t("migrationRun.inputs.emailInvalid") : undefined}>
            <TextInput type="email" value={acmeEmail} onChange={(e) => setAcmeEmail(e.target.value)} autoComplete="off" style={{ minHeight: 44 }} />
          </Field>
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
          <Field label={t("migrationRun.launch.observe")} hint={t("migrationRun.launch.observeHint")} error={issues.includes("observe") ? t("migrationRun.launch.observeInvalid") : undefined}>
            <NumberInput min={0} max={4320} value={observe} onChange={(e) => setObserve(e.target.value)} style={{ minHeight: 44 }} />
          </Field>
        </div>

        <Checkbox checked={allowBind} onChange={setAllowBind} label={t("migrationRun.inputs.allowBind")} />
        <Checkbox checked={probe} onChange={setProbe} label={t("migrationRun.inputs.allowLiveShapeProbe")} />

        <AdvancedFields value={adv} onChange={setAdv} issues={issues} />

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
          <Btn variant="ghost" onClick={onClose} disabled={create.isPending}>{t("common.cancel")}</Btn>
          <Btn type="submit" disabled={issues.length > 0 || servers.length === 0 || blockedUsed.length > 0 || !!campaignRefused || (!dryRun && agentGaps.length > 0)} loading={create.isPending}>
            {campaign ? t("placement.campaign.create", { count: preview.data?.runs?.length ?? 0 }) : dryRun ? t("migrationRun.launch.createDry") : t("migrationRun.launch.create")}
          </Btn>
        </div>
      </form>
    </Modal>
  );
}
