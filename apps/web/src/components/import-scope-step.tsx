"use client";

import { useEffect, useMemo, useState } from "react";
import { useT } from "../i18n/provider";
import { SectionCard, Btn } from "./ui";
import { TeamPicker } from "./team-picker";
import { UNKNOWN_SOURCE_HOST } from "../lib/migration-run";
import {
  autoSelection,
  autoTargetOf,
  buildScope,
  defaultTeamId,
  hostTugra,
  inPlaceBlock,
  inPlaceCount,
  inScopeRefs,
  involvedHosts,
  isControlPlaneHost,
  missingDependencies,
  placementKindOf,
  scopeIssue,
  serverReadiness,
  sourceHostRows,
  sourceProjectRows,
  targetOf,
  type ImportScope,
  type ScopeMode,
  type ScopeSelection,
  type ScopeServer,
} from "../lib/import-scope";
import { needsCampaign } from "../lib/campaign";
import type { ImportPlan, Team } from "../lib/types";

export type { ScopeServer };

const label: React.CSSProperties = { display: "block", fontSize: 12, color: "var(--c-tx3)", margin: "0 0 4px" };
const field: React.CSSProperties = { width: "100%", minHeight: 44, padding: "8px 10px", fontSize: 14, background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", color: "var(--c-tx)", fontFamily: "inherit", boxSizing: "border-box" };
const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 10, minHeight: 44, padding: "6px 10px", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", cursor: "pointer" };
const note: React.CSSProperties = { fontSize: 12, color: "var(--c-tx3)", margin: "4px 0 0" };
const NAMES_SHOWN = 3;

/**
 * The first import step: "What are you moving?". A source server (or several), whole projects, or everything. What is picked decides
 * which items are in; each source server that has something in scope is given a Tugra server on the same screen. Nothing is chosen
 * for the user: a source server the hub found to be the same machine as a connected Tugra server goes onto it ("Same machine"), every
 * other one stays without a target until one is picked ("Another server"), and Continue says what is missing. The target team follows
 * the matched servers, else the source team's name, else it is asked.
 */
export function ImportScopeStep({
  plan,
  servers,
  teams,
  initial,
  onContinue,
  onStartOver,
  onSelectionChange,
  onRecheck,
  rechecking,
  startNote,
}: {
  plan: ImportPlan;
  /** Servers the user can write to. */
  servers: ScopeServer[];
  teams: Team[];
  initial?: ScopeSelection;
  onContinue: (scope: ImportScope) => void;
  onStartOver: () => void;
  /** Called whenever the selection changes (the wizard keeps it for a refresh). */
  onSelectionChange?: (sel: ScopeSelection) => void;
  /** Read the servers and the plan again (a server was just added, or an agent came online). */
  onRecheck?: () => void;
  /** Why the step opened as it did (came from a server's scan, an item's Move): one plain line above the choices. */
  startNote?: string;
  rechecking?: boolean;
}) {
  const t = useT();
  const hosts = useMemo(() => sourceHostRows(plan), [plan]);
  const projects = useMemo(() => sourceProjectRows(plan), [plan]);
  const teamIds = useMemo(() => [...new Set(servers.map((s) => s.teamId))], [servers]);
  const [sel, setSel] = useState<ScopeSelection>(() => initial ?? autoSelection(plan));
  useEffect(() => {
    onSelectionChange?.(sel);
  }, [sel, onSelectionChange]);

  // A Coolify move may land on servers of several teams (one Coolify, many teams here): the hub makes one campaign per team, so the team is
  // not asked and every server the person can write to is a target. Any other source is one run, and a run belongs to one team.
  const multiTeamOk = plan.sourceKind === "coolify";
  // derived at render so a servers list that arrives late still yields a team; "" = the user has to pick one
  const teamId = multiTeamOk
    ? teamIds.length === 1 ? teamIds[0] : ""
    : sel.teamId && teamIds.includes(sel.teamId)
      ? sel.teamId
      : servers.find((s) => s.id === Object.values(sel.placement)[0])?.teamId ?? defaultTeamId(plan, servers, teams);
  const teamServers = useMemo(() => (multiTeamOk ? servers : servers.filter((s) => s.teamId === teamId)), [servers, teamId, multiTeamOk]);
  const allowed = useMemo(() => new Set(teamServers.map((s) => s.id)), [teamServers]);

  const inScope = useMemo(() => inScopeRefs(plan, sel), [plan, sel]);
  const involved = useMemo(() => involvedHosts(plan, inScope), [plan, inScope]);
  const missing = useMemo(() => missingDependencies(plan, inScope), [plan, inScope]);
  const serverById = useMemo(() => new Map(servers.map((s) => [s.id, s] as const)), [servers]);
  const scope = useMemo(() => buildScope(plan, sel, allowed, (id) => serverById.get(id)?.teamId), [plan, sel, allowed, serverById]);
  const needsTeam = !multiTeamOk && involved.length > 0 && teamId === "";
  const issue = servers.length === 0 ? "noServers" : needsTeam ? "team" : scopeIssue(plan, scope, (id) => serverById.get(id)?.teamId, (id) => serverReadiness(serverById.get(id)), { multiTeamOk });
  const placedTeams = useMemo(() => new Set(Object.values(scope.placed).map((id) => serverById.get(id)?.teamId ?? id)).size, [scope.placed, serverById]);
  const counts = useMemo(() => {
    const c = { apps: 0, databases: 0, services: 0 };
    for (const it of plan.items) {
      if (!inScope.has(it.itemRef)) continue;
      if (it.kind === "app") c.apps += 1;
      else if (it.kind === "database") c.databases += 1;
      else if (it.kind === "service") c.services += 1;
    }
    return c;
  }, [plan, inScope]);
  const connected = useMemo(() => hosts.filter((h) => autoTargetOf(plan, h.ref) !== "").map((h) => h.ref), [hosts, plan]);

  const setMode = (mode: ScopeMode) => setSel((s) => ({ ...s, mode, extra: new Set() }));
  const toggle = (key: "hosts" | "projects", ref: string) =>
    setSel((s) => {
      const next = new Set(s[key]);
      if (next.has(ref)) next.delete(ref);
      else next.add(ref);
      return { ...s, [key]: next, extra: new Set() };
    });
  const setHosts = (refs: string[]) => setSel((s) => ({ ...s, hosts: new Set(refs), extra: new Set() }));
  const place = (ref: string, id: string) => setSel((s) => ({ ...s, placement: { ...s.placement, [ref]: id } }));
  // the picks stay: they only count while their server is in the chosen team, so going back to a team finds them again
  const pickTeam = (id: string) => setSel((s) => ({ ...s, teamId: id }));
  const hostLabel = (ref: string, name?: string) => (ref === UNKNOWN_SOURCE_HOST ? t(plan.sourceKind === "dokploy" ? "import.scope.panelHost" : "import.scope.unknownHost") : name ?? ref);
  const countsText = (c: { apps: number; databases: number; services: number }) => t("import.scope.counts", c);
  const teamName = (id: string) => teams.find((x) => x.id === id)?.name ?? "";
  const sourceTeam = plan.preflight?.sourceTeam?.trim() ?? "";
  const stateText = (s: ScopeServer): string => {
    const r = serverReadiness(s);
    return r === "ready" ? s.name : `${s.name} (${t(`import.scope.state.${r}`)})`;
  };
  const addServerHref = (name: string) => `/servers/new?name=${encodeURIComponent(name)}${teamId ? `&team=${encodeURIComponent(teamId)}` : ""}`;

  const MODES: Array<{ mode: ScopeMode; show: boolean }> = [
    { mode: "servers", show: hosts.length > 0 },
    { mode: "projects", show: projects.length > 0 },
    { mode: "everything", show: true },
  ];

  const unplaced = involved.filter((h) => !scope.placed[h.ref]).map((h) => hostLabel(h.ref, h.name));
  const issueText = (): string => {
    switch (issue) {
      case "nothing": return t("import.scope.issue.nothing");
      case "teams": return t("import.scope.issue.teams");
      case "noServers": return t("import.review.noTarget");
      case "team": return t("import.scope.issue.team");
      case "target": return t("import.scope.issue.target", { names: unplaced.slice(0, NAMES_SHOWN).join(", ") + (unplaced.length > NAMES_SHOWN ? ` +${unplaced.length - NAMES_SHOWN}` : "") });
      case "blocked": return t("import.scope.issue.blocked");
      case "unready": return t("import.scope.issue.unready");
      case "limit": return t("import.scope.issue.limit", { max: 64 });
      default: return t("import.scope.summary", counts);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 720 }}>
      <SectionCard
        title={t("import.scope.title")}
        desc={t("import.scope.subtitle")}
        right={<Btn variant="ghost" onClick={onStartOver}>{t("import.startOver")}</Btn>}
        style={{ padding: 20, marginBottom: 0 }}
      >
        {startNote && <p data-testid="scope-note" role="note" style={{ fontSize: 12, color: "var(--c-tx2)", margin: "0 0 10px" }}>{startNote}</p>}
        <div role="radiogroup" aria-label={t("import.scope.title")} style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
          {MODES.filter((m) => m.show).map(({ mode }) => {
            const checked = sel.mode === mode;
            return (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={checked}
                onClick={() => setMode(mode)}
                style={{ flex: "1 1 180px", textAlign: "left", fontFamily: "inherit", minHeight: 44, padding: "10px 14px", borderRadius: "var(--r1)", cursor: "pointer", border: "1px solid var(--c-bd)", background: checked ? "var(--c-a)" : "var(--c-el)", color: checked ? "var(--c-on-a)" : "var(--c-tx)" }}
              >
                <span style={{ display: "block", fontSize: 14, fontWeight: 600 }}>{t(`import.scope.mode.${mode}`)}</span>
                <span style={{ display: "block", fontSize: 12, opacity: 0.85 }}>{t(`import.scope.mode.${mode}Hint`)}</span>
              </button>
            );
          })}
        </div>

        {sel.mode === "servers" && (
          <fieldset style={{ border: 0, padding: 0, margin: "0 0 16px" }}>
            <legend style={label}>{t("import.scope.serversLabel")}</legend>
            {hosts.length > 1 && (
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, margin: "0 0 8px" }}>
                <span role="status" style={{ flex: "1 1 220px", fontSize: 12, color: "var(--c-tx2)" }}>{t("import.scope.connectedHeadline", { connected: connected.length, total: hosts.length })}</span>
                <Btn variant="ghost" onClick={() => setHosts(hosts.map((h) => h.ref))}>{t("import.scope.selectAll")}</Btn>
                {connected.length > 0 && <Btn variant="ghost" onClick={() => setHosts(connected)}>{t("import.scope.selectConnected", { count: connected.length })}</Btn>}
                {sel.hosts.size > 0 && <Btn variant="ghost" onClick={() => setHosts([])}>{t("import.scope.clear")}</Btn>}
              </div>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {hosts.map((h) => {
                const m = hostTugra(plan, h.ref);
                const cp = isControlPlaneHost(plan, h.ref);
                return (
                  <label key={h.ref} style={row}>
                    <input type="checkbox" checked={sel.hosts.has(h.ref)} onChange={() => toggle("hosts", h.ref)} style={{ width: 20, height: 20 }} />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: "block", fontSize: 14, fontWeight: 600, overflowWrap: "anywhere" }}>{hostLabel(h.ref, h.name)}</span>
                      <span style={{ display: "block", fontSize: 12, color: "var(--c-tx3)" }}>{countsText(h)}</span>
                      <span style={{ display: "block", fontSize: 12, color: m ? "var(--c-g)" : "var(--c-tx3)" }}>
                        {m ? t(m.confidence === "certain" ? "import.scope.match.connected" : "import.scope.match.probable", { name: m.name }) : t("import.scope.match.none")}
                        {cp ? ` · ${t("import.scope.controlPlane")}` : ""}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        )}

        {sel.mode === "projects" && (
          <fieldset style={{ border: 0, padding: 0, margin: "0 0 16px" }}>
            <legend style={label}>{t("import.scope.projectsLabel")}</legend>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {projects.map((p) => (
                <label key={p.ref} style={row}>
                  <input type="checkbox" checked={sel.projects.has(p.ref)} onChange={() => toggle("projects", p.ref)} style={{ width: 20, height: 20 }} />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: "block", fontSize: 14, fontWeight: 600, overflowWrap: "anywhere" }}>{p.name}</span>
                    <span style={{ display: "block", fontSize: 12, color: "var(--c-tx3)" }}>{countsText(p)}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        )}

        {missing.length > 0 && (
          <div role="status" style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: 10, margin: "0 0 16px", fontSize: 12, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ flex: "1 1 220px", color: "var(--c-am)" }}>
              {missing.length <= NAMES_SHOWN ? (
                t("import.scope.needs", { names: missing.map((m) => m.name).join(", ") })
              ) : (
                <details>
                  <summary style={{ cursor: "pointer" }}>{t("import.scope.needsCount", { count: missing.length })}</summary>
                  <span style={{ display: "block", overflowWrap: "anywhere" }}>{missing.map((m) => m.name).join(", ")}</span>
                </details>
              )}
            </span>
            <Btn variant="ghost" onClick={() => setSel((s) => ({ ...s, extra: new Set([...s.extra, ...missing.map((m) => m.itemRef)]) }))}>{t("import.scope.addNeeded")}</Btn>
          </div>
        )}

        {servers.length === 0 ? (
          <p role="alert" style={{ fontSize: 12, color: "var(--c-am)", margin: "0 0 12px" }}>{t("import.review.noTarget")}</p>
        ) : involved.length > 0 ? (
          <div style={{ margin: "0 0 16px" }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>{t("import.scope.placementTitle")}</div>
            {!multiTeamOk && (teamIds.length > 1 || teamId === "") && (
              <div style={{ margin: "8px 0", maxWidth: 360 }}>
                {sourceTeam && <p style={{ ...note, margin: "0 0 6px" }}>{t("import.scope.sourceTeam", { team: sourceTeam })}</p>}
                <label htmlFor="imp-scope-team" style={label}>{t("import.scope.team")}</label>
                <TeamPicker id="imp-scope-team" value={teamId} teams={teams.filter((x) => teamIds.includes(x.id))} onChange={pickTeam} />
                {teamId !== "" && sourceTeam && teamName(teamId).trim().toLowerCase() !== sourceTeam.toLowerCase() && <p role="status" style={{ ...note, color: "var(--c-am)" }}>{t("import.scope.teamDiffers")}</p>}
              </div>
            )}
            {teamId !== "" && teamIds.length <= 1 && teamName(teamId) && (
              <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "8px 0 0" }}>{t("import.scope.teamIs", { team: teamName(teamId) })}</p>
            )}
            {(multiTeamOk || teamId !== "") && (
              <div style={{ display: "grid", gap: 14, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 260px), 1fr))", marginTop: 8 }}>
                {involved.map((h) => {
                  const id = `imp-scope-to-${h.ref.replace(/[^A-Za-z0-9_-]/g, "_")}`;
                  const m = hostTugra(plan, h.ref);
                  const block = inPlaceBlock(plan, h.ref);
                  const target = targetOf(plan, sel, h.ref, allowed);
                  const kind = target ? placementKindOf(plan, h.ref, target) : null;
                  const matched = m ? serverById.get(m.serverId) : undefined;
                  const matchedState = matched ? serverReadiness(matched) : "ready";
                  const name = hostLabel(h.ref, h.name);
                  return (
                    <div key={h.ref}>
                      <label htmlFor={id} style={label}>{t("import.scope.movesToLabel", { name })}</label>
                      <select id={id} style={field} value={target} onChange={(e) => place(h.ref, e.target.value)}>
                        {target === "" && <option value="" disabled>{t("import.scope.choose")}</option>}
                        {(multiTeamOk && teamIds.length > 1 ? teamIds : [""]).map((tid) => {
                          const group = tid === "" ? teamServers : teamServers.filter((s) => s.teamId === tid);
                          const options = group.map((s) => {
                            const sameMachine = m?.serverId === s.id;
                            return (
                              <option key={s.id} value={s.id} disabled={serverReadiness(s) !== "ready" || (sameMachine && block !== null)}>
                                {stateText(s)}{sameMachine && block === null ? ` · ${t("import.scope.sameMachineTag")}` : ""}
                              </option>
                            );
                          });
                          // servers of several teams are told apart by the team they belong to
                          return tid === "" ? options : <optgroup key={tid} label={teamName(tid) || tid}>{options}</optgroup>;
                        })}
                      </select>
                      {kind === "in-place" && <p style={{ ...note, color: "var(--c-tx2)" }}><strong>{t("import.scope.kind.inPlaceTitle")}</strong> {t("import.scope.kind.inPlace")}</p>}
                      {kind === "other-server" && <p style={{ ...note, color: "var(--c-tx2)" }}><strong>{t("import.scope.kind.otherTitle")}</strong> {t("import.scope.kind.other")}</p>}
                      {block === "control-plane" && <p role="status" style={{ ...note, color: "var(--c-am)" }}>{t("import.scope.block.controlPlane")}</p>}
                      {block === "unsupported-source" && m && <p style={note}>{t("import.scope.block.unsupported")}</p>}
                      {m && m.confidence === "probable" && block === null && !target && (
                        <p style={note}>
                          {t("import.scope.match.probable", { name: m.name })}{" "}
                          <Btn variant="ghost" onClick={() => place(h.ref, m.serverId)}>{t("import.scope.useIt")}</Btn>
                        </p>
                      )}
                      {m && matchedState !== "ready" && (
                        <p role="status" style={{ ...note, color: "var(--c-am)" }}>{t(`import.scope.matchedState.${matchedState}`, { name: m.name })}</p>
                      )}
                      {!m && (
                        <p style={note}>
                          {t("import.scope.match.none")}{" · "}
                          <a href={addServerHref(name)} target="_blank" rel="noopener noreferrer" style={{ color: "var(--c-lapis)" }}>{t("import.scope.addServer")}</a>
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {inPlaceCount(scope) > 1 && <p style={{ ...note, marginTop: 10 }}>{t("import.scope.inPlaceNote", { count: inPlaceCount(scope) })}</p>}
            {needsCampaign(scope) && <p role="note" style={{ ...note, marginTop: 10 }}>{t("import.scope.campaignNote")}</p>}
            {scope.multiTeam && <p role="note" data-testid="multi-team-note" style={{ ...note, marginTop: 6 }}>{t("import.scope.multiTeamNote", { count: placedTeams })}</p>}
            {onRecheck && (involved.some((h) => !hostTugra(plan, h.ref)) || (teamId !== "" && involved.some((h) => { const m = hostTugra(plan, h.ref); return m && serverReadiness(serverById.get(m.serverId)) !== "ready"; }))) && (
              <div style={{ marginTop: 10 }}>
                <Btn variant="ghost" onClick={onRecheck} disabled={rechecking}>{t("import.scope.recheck")}</Btn>
                <span style={{ ...note, marginLeft: 8 }}>{t("import.scope.recheckHint")}</span>
              </div>
            )}
          </div>
        ) : null}

        <p aria-live="polite" style={{ fontSize: 13, margin: "0 0 12px", color: issue && issue !== "nothing" ? "var(--c-am)" : undefined }}>
          {issueText()}
        </p>

        <Btn onClick={() => onContinue(scope)} disabled={issue !== null} style={{ minHeight: 44 }}>{t("import.scope.continue")}</Btn>

        <details style={{ marginTop: 14 }}>
          <summary style={{ fontSize: 12, color: "var(--c-tx3)", cursor: "pointer", minHeight: 24 }}>{t("import.scope.more")}</summary>
          <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "6px 0 0" }}>{t("import.scope.moreBody")}</p>
        </details>
      </SectionCard>
    </div>
  );
}
