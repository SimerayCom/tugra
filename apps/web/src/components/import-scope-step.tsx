"use client";

import { useMemo, useState } from "react";
import { useT } from "../i18n/provider";
import { SectionCard, Btn } from "./ui";
import { TeamPicker } from "./team-picker";
import { UNKNOWN_SOURCE_HOST } from "../lib/migration-run";
import {
  buildScope,
  emptySelection,
  inScopeRefs,
  involvedHosts,
  missingDependencies,
  scopeIssue,
  sourceHostRows,
  sourceProjectRows,
  type ImportScope,
  type ScopeMode,
  type ScopeSelection,
} from "../lib/import-scope";
import type { ImportPlan, Team } from "../lib/types";

const label: React.CSSProperties = { display: "block", fontSize: 12, color: "var(--c-tx3)", margin: "0 0 4px" };
const field: React.CSSProperties = { width: "100%", minHeight: 44, padding: "8px 10px", fontSize: 14, background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", color: "var(--c-tx)", fontFamily: "inherit", boxSizing: "border-box" };
const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 10, minHeight: 44, padding: "6px 10px", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", cursor: "pointer" };

export interface ScopeServer {
  id: string;
  name: string;
  teamId: string;
}

/**
 * The first import step: "What are you moving?". A source server (or several), whole projects, or everything. What is picked decides
 * which items are in; each source server that has something in scope is given a Tugra server on the same screen, and the target team
 * follows from those servers (a team picker shows only when the servers you can write to belong to several teams).
 */
export function ImportScopeStep({
  plan,
  servers,
  teams,
  initial,
  onContinue,
  onStartOver,
}: {
  plan: ImportPlan;
  /** Servers the user can write to. */
  servers: ScopeServer[];
  teams: Team[];
  initial?: ScopeSelection;
  onContinue: (scope: ImportScope) => void;
  onStartOver: () => void;
}) {
  const t = useT();
  const hosts = useMemo(() => sourceHostRows(plan), [plan]);
  const projects = useMemo(() => sourceProjectRows(plan), [plan]);
  const teamIds = useMemo(() => [...new Set(servers.map((s) => s.teamId))], [servers]);
  const [teamId, setTeamId] = useState(() => (initial?.placement && servers.find((s) => s.id === Object.values(initial.placement)[0])?.teamId) || teamIds[0] || "");
  const teamServers = useMemo(() => servers.filter((s) => s.teamId === teamId), [servers, teamId]);
  const fallback = teamServers[0]?.id ?? "";
  const [sel, setSel] = useState<ScopeSelection>(() => initial ?? { ...emptySelection(), mode: hosts.length > 1 ? "servers" : "everything" });

  const inScope = useMemo(() => inScopeRefs(plan, sel), [plan, sel]);
  const involved = useMemo(() => involvedHosts(plan, inScope), [plan, inScope]);
  const missing = useMemo(() => missingDependencies(plan, inScope), [plan, inScope]);
  const scope = useMemo(() => buildScope(plan, sel, fallback), [plan, sel, fallback]);
  const teamOf = (id: string) => servers.find((s) => s.id === id)?.teamId;
  const issue = servers.length === 0 ? "target" : scopeIssue(plan, scope, teamOf);
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

  const setMode = (mode: ScopeMode) => setSel((s) => ({ ...s, mode, extra: new Set() }));
  const toggle = (key: "hosts" | "projects", ref: string) =>
    setSel((s) => {
      const next = new Set(s[key]);
      if (next.has(ref)) next.delete(ref);
      else next.add(ref);
      return { ...s, [key]: next, extra: new Set() };
    });
  const place = (ref: string, id: string) => setSel((s) => ({ ...s, placement: { ...s.placement, [ref]: id } }));
  const pickTeam = (id: string) => {
    setTeamId(id);
    // the old picks belong to the other team's servers
    setSel((s) => ({ ...s, placement: {} }));
  };
  const hostLabel = (ref: string, name?: string) => (ref === UNKNOWN_SOURCE_HOST ? t("import.scope.unknownHost") : name ?? ref);
  const countsText = (c: { apps: number; databases: number; services: number }) => t("import.scope.counts", c);

  const MODES: Array<{ mode: ScopeMode; show: boolean }> = [
    { mode: "servers", show: hosts.length > 0 },
    { mode: "projects", show: projects.length > 0 },
    { mode: "everything", show: true },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 720 }}>
      <SectionCard
        title={t("import.scope.title")}
        desc={t("import.scope.subtitle")}
        right={<Btn variant="ghost" onClick={onStartOver}>{t("import.startOver")}</Btn>}
        style={{ padding: 20, marginBottom: 0 }}
      >
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
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {hosts.map((h) => (
                <label key={h.ref} style={row}>
                  <input type="checkbox" checked={sel.hosts.has(h.ref)} onChange={() => toggle("hosts", h.ref)} style={{ width: 20, height: 20 }} />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: "block", fontSize: 14, fontWeight: 600, overflowWrap: "anywhere" }}>{hostLabel(h.ref, h.name)}</span>
                    <span style={{ display: "block", fontSize: 12, color: "var(--c-tx3)" }}>{countsText(h)}</span>
                  </span>
                </label>
              ))}
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
            <span style={{ flex: "1 1 220px", color: "var(--c-am)" }}>{t("import.scope.needs", { names: missing.map((m) => m.name).join(", ") })}</span>
            <Btn variant="ghost" onClick={() => setSel((s) => ({ ...s, extra: new Set([...s.extra, ...missing.map((m) => m.itemRef)]) }))}>{t("import.scope.addNeeded")}</Btn>
          </div>
        )}

        {servers.length === 0 ? (
          <p role="alert" style={{ fontSize: 12, color: "var(--c-am)", margin: "0 0 12px" }}>{t("import.review.noTarget")}</p>
        ) : involved.length > 0 ? (
          <div style={{ margin: "0 0 16px" }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>{t("import.scope.placementTitle")}</div>
            {teamIds.length > 1 && (
              <div style={{ margin: "8px 0", maxWidth: 360 }}>
                <label htmlFor="imp-scope-team" style={label}>{t("import.scope.team")}</label>
                <TeamPicker id="imp-scope-team" value={teamId} teams={teams.filter((x) => teamIds.includes(x.id))} onChange={pickTeam} />
              </div>
            )}
            {teamServers.length === 1 ? (
              <p style={{ fontSize: 12, color: "var(--c-tx2)", margin: "4px 0 0" }}>{t("import.scope.movesTo", { server: teamServers[0].name })}</p>
            ) : (
              <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 260px), 1fr))", marginTop: 8 }}>
                {involved.map((h) => {
                  const id = `imp-scope-to-${h.ref.replace(/[^A-Za-z0-9_-]/g, "_")}`;
                  return (
                    <div key={h.ref}>
                      <label htmlFor={id} style={label}>{t("import.scope.movesToLabel", { name: hostLabel(h.ref, h.name) })}</label>
                      <select id={id} style={field} value={sel.placement[h.ref] && teamServers.some((s) => s.id === sel.placement[h.ref]) ? sel.placement[h.ref] : fallback} onChange={(e) => place(h.ref, e.target.value)}>
                        {teamServers.map((s) => (
                          <option key={s.id} value={s.id}>{s.name}</option>
                        ))}
                      </select>
                    </div>
                  );
                })}
              </div>
            )}
            {teamIds.length <= 1 && teams.find((x) => x.id === teamId) && (
              <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "8px 0 0" }}>{t("import.scope.teamIs", { team: teams.find((x) => x.id === teamId)!.name })}</p>
            )}
          </div>
        ) : null}

        <p aria-live="polite" style={{ fontSize: 13, margin: "0 0 12px" }}>
          {issue === "nothing" ? t("import.scope.issue.nothing") : issue === "teams" ? t("import.scope.issue.teams") : t("import.scope.summary", counts)}
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
