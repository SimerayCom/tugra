"use client";

import { useT } from "../../i18n/provider";
import type { CampaignRunPlan } from "@tugra/shared";
import type { CampaignPreview } from "../../lib/api";
import { placementFailureKey, rebuildChoicesOf, runsByWave, sourcesOfRun } from "../../lib/campaign";
import { toggleChoice } from "../../lib/inplace";
import type { ImportPlanItem } from "../../lib/types";
import { PlanAppRows } from "../plan-app-rows";
import { UNKNOWN_SOURCE_HOST, type SourceServerRow } from "../../lib/migration-run";
import { hostOfItemRef } from "../../lib/import-scope";

/**
 * What a mixed placement becomes, shown before anything is created: one run for the servers that move to another server, then one run per server
 * that stays on its own machine, in waves. Names only. A refused placement says why, in words, and the create button stays off.
 */
export function CampaignPreviewCard({
  preview,
  loading,
  failed,
  rows,
  servers,
  items = [],
  inScope,
  rebuild = [],
  onRebuild,
  disabled = false,
  teams = [],
  inPlaceOnly = false,
}: {
  preview: CampaignPreview | null;
  loading: boolean;
  failed: boolean;
  rows: SourceServerRow[];
  servers: Array<{ id: string; name: string }>;
  /** The plan's items: the apps of a same-machine run are offered for a rebuild (absent = no picker). */
  items?: ReadonlyArray<Pick<ImportPlanItem, "itemRef" | "kind" | "name"> & Partial<Pick<ImportPlanItem, "proposed">>>;
  inScope?: ReadonlySet<string>;
  /** The apps the owner chose to build with Tugra and verify (plan item refs). */
  rebuild?: readonly string[];
  onRebuild?: (next: string[]) => void;
  disabled?: boolean;
  /** Team names, so a campaign per team is headed by the team it belongs to. */
  teams?: ReadonlyArray<{ id: string; name: string }>;
  /** Every server stays on its own machine: one card per server (what it holds, what happens to it), the rebuild choice folded away. */
  inPlaceOnly?: boolean;
}) {
  const t = useT();
  const nameOfSource = (ref: string): string => {
    const r = rows.find((x) => x.ref === ref);
    return ref === UNKNOWN_SOURCE_HOST ? t("migrationRun.launch.placement.unknownHost") : (r?.name ?? ref);
  };
  const nameOfServer = (id: string): string => servers.find((s) => s.id === id)?.name ?? id;
  const countsOf = (refs: string[]) => {
    const c = { apps: 0, databases: 0, services: 0 };
    for (const it of items) {
      if ((inScope && !inScope.has(it.itemRef)) || !refs.includes(hostOfItemRef(it.itemRef))) continue;
      if (it.kind === "app") c.apps += 1;
      else if (it.kind === "database") c.databases += 1;
      else if (it.kind === "service") c.services += 1;
    }
    return c;
  };
  /** The apps of a run's servers (in scope), with what the plan says about how each looks. */
  const appsOf = (refs: string[]) => items.filter((it) => it.kind === "app" && (!inScope || inScope.has(it.itemRef)) && refs.includes(hostOfItemRef(it.itemRef))).map((it) => ({ itemRef: it.itemRef, name: it.name, proposed: it.proposed ?? {} }));
  const renderCards = (runs: CampaignRunPlan[]) => (
    <ol style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 8 }}>
      {runsByWave(runs).flatMap((w) =>
        w.runs.map((r) => {
          const name = sourcesOfRun(r).map(nameOfSource).join(", ");
          return (
            <li key={`${w.wave}:${r.sourceServerRef}`} data-testid="in-place-card" style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: "10px 12px", display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                <strong style={{ fontSize: 13, overflowWrap: "anywhere" }}>{name}</strong>
                <span style={{ fontSize: 11, color: "var(--c-tx3)" }}>{t("placement.campaign.wave", { n: w.wave + 1 })}</span>
              </div>
              <span style={{ fontSize: 12, color: "var(--c-tx2)" }}>{t("import.scope.counts", countsOf(sourcesOfRun(r)))}</span>
              <PlanAppRows apps={appsOf(sourcesOfRun(r))} />
              <span style={{ fontSize: 12, color: "var(--c-tx3)", lineHeight: 1.5 }}>{t("placement.campaign.cardInPlace")}</span>
              {onRebuild && (
                <details>
                  <summary style={{ cursor: "pointer", fontSize: 12, minHeight: 28, display: "flex", alignItems: "center" }}>{t("placement.campaign.rebuild.summary")}</summary>
                  <RebuildPicker choices={rebuildChoicesOf(r, items, inScope)} chosen={rebuild} onChange={onRebuild} disabled={disabled} serverName={name} />
                </details>
              )}
            </li>
          );
        }),
      )}
    </ol>
  );
  const renderRuns = (runs: CampaignRunPlan[]) => inPlaceOnly ? renderCards(runs) : (
    <ol style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 6, fontSize: 12, lineHeight: 1.5 }}>
      {runsByWave(runs).flatMap((w) =>
        w.runs.map((r) => (
          <li key={`${w.wave}:${r.sourceServerRef}`}>
            <strong>{t("placement.campaign.wave", { n: w.wave + 1 })}</strong>
            {": "}
            {r.kind === "in-place" ? t("placement.campaign.runInPlace", { source: sourcesOfRun(r).map(nameOfSource).join(", ") }) : t("placement.campaign.runOther", { source: sourcesOfRun(r).map(nameOfSource).join(", "), target: nameOfServer(r.targetServerId) })}
            <PlanAppRows apps={appsOf(sourcesOfRun(r))} />
            {r.kind === "in-place" && onRebuild && (
              <RebuildPicker choices={rebuildChoicesOf(r, items, inScope)} chosen={rebuild} onChange={onRebuild} disabled={disabled} serverName={sourcesOfRun(r).map(nameOfSource).join(", ")} />
            )}
          </li>
        )),
      )}
    </ol>
  );
  return (
    <fieldset data-testid="campaign-preview" style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: 12, margin: 0, display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
      <legend style={{ fontSize: 12, fontWeight: 700, color: "var(--c-tx2)", padding: "0 6px" }}>{inPlaceOnly ? t("placement.campaign.serversTitle") : t("placement.campaign.title")}</legend>
      {!inPlaceOnly && <p style={{ margin: 0, fontSize: 12, color: "var(--c-tx3)", lineHeight: 1.5 }}>{t("placement.campaign.hint")}</p>}
      {loading && <p role="status" style={{ margin: 0, fontSize: 12 }}>{t("placement.campaign.checking")}</p>}
      {failed && <p role="alert" style={{ margin: 0, fontSize: 12, color: "var(--c-r)" }}>{t("placement.campaign.unreadable")}</p>}
      {preview?.failure && (
        <p role="alert" style={{ margin: 0, fontSize: 12, color: "var(--c-r)", lineHeight: 1.5 }}>
          {t(placementFailureKey(preview.failure.code))}
          {preview.failure.ref ? ` (${[preview.failure.withRef, preview.failure.ref].filter((r): r is string => !!r).map(nameOfSource).join(", ")})` : ""}
          {preview.failure.reason ? ` ${t(`placement.lock.${preview.failure.reason}`)}` : ""}
        </p>
      )}
      {preview?.runs && preview.teams && preview.teams.length > 1 ? (
        <>
          <p role="note" data-testid="campaign-teams-note" style={{ margin: 0, fontSize: 12, color: "var(--c-tx2)", lineHeight: 1.5 }}>{t("placement.campaign.teamsNote", { count: preview.teams.length })}</p>
          {preview.teams.map((tp, i) => (
            <div key={tp.teamId} data-testid="campaign-team" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <strong style={{ fontSize: 12 }}>{t("placement.campaign.team", { name: teams.find((x) => x.id === tp.teamId)?.name ?? t("placement.campaign.teamN", { n: i + 1 }), count: tp.servers })}</strong>
              {renderRuns(tp.runs)}
            </div>
          ))}
        </>
      ) : (
        preview?.runs && renderRuns(preview.runs)
      )}
    </fieldset>
  );
}

/**
 * The per-app choice of an in-place wave: by default every app reuses the image Coolify built and nothing is built; ticking an app builds it
 * with Tugra and verifies it before the ports are taken. Large touch targets, one column on a phone.
 */
export function RebuildPicker({ choices, chosen, onChange, disabled, serverName }: { choices: ReadonlyArray<{ itemRef: string; name: string }>; chosen: readonly string[]; onChange: (next: string[]) => void; disabled: boolean; serverName: string }) {
  const t = useT();
  const mine = choices.filter((c) => chosen.includes(c.itemRef)).length;
  return (
    <fieldset data-testid="rebuild-picker" aria-label={`${t("placement.campaign.rebuild.title")}: ${serverName}`} style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: 10, margin: "6px 0 0", display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
      <legend style={{ fontSize: 12, fontWeight: 600, padding: "0 6px" }}>{t("placement.campaign.rebuild.title")}</legend>
      <p style={{ margin: 0, fontSize: 11, color: "var(--c-tx3)", lineHeight: 1.5 }}>{t("placement.campaign.rebuild.hint")}</p>
      {choices.length === 0 && <p style={{ margin: 0, fontSize: 12, color: "var(--c-tx3)" }}>{t("placement.campaign.rebuild.none")}</p>}
      {choices.map((c) => (
        <label key={c.itemRef} style={{ display: "flex", gap: 10, alignItems: "center", minHeight: 44, fontSize: 13, overflowWrap: "anywhere" }}>
          <input type="checkbox" checked={chosen.includes(c.itemRef)} onChange={() => onChange(toggleChoice(chosen, c.itemRef))} disabled={disabled} style={{ width: 20, height: 20, flexShrink: 0 }} />
          <span>{t("placement.campaign.rebuild.option", { name: c.name })}</span>
        </label>
      ))}
      {choices.length > 0 && <p data-testid="rebuild-summary" style={{ margin: 0, fontSize: 11, color: "var(--c-tx3)" }}>{mine > 0 ? t("placement.campaign.rebuild.chosen", { count: mine }) : t("placement.campaign.rebuild.default")}</p>}
    </fieldset>
  );
}
