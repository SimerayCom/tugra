"use client";

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useT } from "../../i18n/provider";
import { api } from "../../lib/api";
import { coolifyTeams } from "../../lib/import-team";
import { createCount, mapBody, newTeamName, ownedTeams, startingChoices, suggestTeam, teamMapIssue, type TeamChoice } from "../../lib/import-team-map";
import type { ImportPlan, Team } from "../../lib/types";
import { Select, type Option } from "../form";
import { SectionCard, Btn } from "../ui";

const CREATE = "__create";
const SKIP = "__skip";
const valueOf = (c: TeamChoice): string => (c.kind === "use" ? c.teamId : c.kind === "create" ? CREATE : c.kind === "skip" ? SKIP : "");

/**
 * Right after the Coolify read: every Coolify team with the Tugra team it goes into. The team of the same name is preselected (it only
 * names a place); a Coolify team with no match starts undecided, because creating a team writes something. The owner can pick another
 * team, create one in place, or leave a Coolify team out. Continue saves the mapping on the import session, so a refresh keeps it.
 */
export function TeamMapStep({ plan, sessionId, teams, onDone, onStartOver }: { plan: ImportPlan; sessionId: string; teams: Team[]; onDone: (teamMap: Record<string, string | null>) => void; onStartOver: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const coolify = useMemo(() => coolifyTeams(plan), [plan]);
  const [choices, setChoices] = useState<Record<string, TeamChoice>>(() => startingChoices(plan, teams));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const owned = useMemo(() => ownedTeams(teams), [teams]);
  const issue = teamMapIssue(choices);
  const creating = createCount(choices);
  const moving = Object.values(choices).filter((c) => c.kind !== "skip").length;

  const optionsFor = (name: string): Option[] => {
    const match = suggestTeam(name, teams).teamId;
    const ordered = [...owned].sort((a, b) => (a.id === match ? -1 : 0) || (b.id === match ? 1 : 0) || a.name.localeCompare(b.name));
    return [
      ...ordered.map((x) => ({ value: x.id, label: x.name })),
      { value: CREATE, label: t("import.teamMap.create", { name: newTeamName(name) }) },
      { value: SKIP, label: t("import.teamMap.skip") },
    ];
  };
  const pick = (ref: string, value: string) => setChoices((c) => ({ ...c, [ref]: value === CREATE ? { kind: "create" } : value === SKIP ? { kind: "skip" } : { kind: "use", teamId: value } }));

  const save = async () => {
    setBusy(true);
    setError("");
    const created: Record<string, string> = {};
    let current = choices;
    try {
      for (const ct of coolify) {
        if (current[ct.ref]?.kind !== "create") continue;
        try {
          const made = await api.createTeam(newTeamName(ct.name));
          created[ct.ref] = made.id;
          // a retry after a later failure must reuse this team, never make a second one
          current = { ...current, [ct.ref]: { kind: "use", teamId: made.id } };
          setChoices(current);
        } catch (e) {
          setError(t("import.teamMap.createFailed", { name: ct.name, reason: (e as Error).message }));
          return;
        }
      }
      if (Object.keys(created).length) await qc.invalidateQueries({ queryKey: ["teams"] });
      try {
        const saved = await api.importTeamMap(sessionId, mapBody(current, created));
        onDone(saved.teamMap);
      } catch (e) {
        setError(t("import.teamMap.saveFailed", { reason: (e as Error).message }));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 720 }} data-testid="team-map-step">
      <SectionCard title={t("import.teamMap.title")} desc={t("import.teamMap.subtitle")} right={<Btn variant="ghost" onClick={onStartOver}>{t("import.startOver")}</Btn>} style={{ padding: 20, marginBottom: 0 }}>
        <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>{t("import.teamMap.ownersOnly")}</p>
        <div style={{ display: "grid", gap: 14, margin: "0 0 16px" }}>
          {coolify.map((ct) => {
            const c = choices[ct.ref] ?? { kind: "none" as const };
            const m = suggestTeam(ct.name, teams);
            const id = `team-map-${ct.ref}`;
            return (
              <div key={ct.ref} data-testid={`team-map-${ct.ref}`} style={{ display: "grid", gap: 6, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 240px), 1fr))", alignItems: "start" }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, overflowWrap: "anywhere" }}>{ct.name}</div>
                  <div style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("import.teamMap.holds", { items: ct.items, projects: ct.projects, servers: ct.hosts })}</div>
                </div>
                <div style={{ minWidth: 0 }}>
                  <label htmlFor={id} style={{ display: "block", fontSize: 12, color: "var(--c-tx3)", margin: "0 0 4px" }}>{t("import.teamMap.movesInto")}</label>
                  <Select id={id} value={valueOf(c)} onChange={(v) => pick(ct.ref, v)} options={optionsFor(ct.name)} placeholder={t("import.teamMap.choose")} disabled={busy} />
                  {c.kind === "use" && c.teamId === m.teamId && <p style={{ fontSize: 12, color: "var(--c-g)", margin: "4px 0 0" }}>{t("import.teamMap.sameName")}</p>}
                  {c.kind === "create" && <p role="note" style={{ fontSize: 12, color: "var(--c-tx2)", margin: "4px 0 0" }}>{t("import.teamMap.createNote")}</p>}
                  {c.kind === "skip" && <p style={{ fontSize: 12, color: "var(--c-tx2)", margin: "4px 0 0" }}>{t("import.teamMap.skipNote")}</p>}
                  {c.kind === "none" && m.notOwned && <p role="status" style={{ fontSize: 12, color: "var(--c-am)", margin: "4px 0 0" }}>{t("import.teamMap.notOwned")}</p>}
                </div>
              </div>
            );
          })}
        </div>
        <p aria-live="polite" style={{ fontSize: 13, margin: "0 0 12px", color: issue ? "var(--c-am)" : undefined }}>
          {issue ? t(`import.teamMap.issue.${issue}`) : t("import.teamMap.issue.ready", { count: moving })}
        </p>
        {error && <p role="alert" style={{ fontSize: 12, color: "var(--c-r)", margin: "0 0 12px" }}>{error}</p>}
        <Btn onClick={() => void save()} disabled={issue !== null || busy} loading={busy} style={{ minHeight: 44 }}>
          {busy ? t("import.teamMap.saving") : creating > 0 ? t("import.teamMap.continueCreate") : t("import.teamMap.continue")}
        </Btn>
      </SectionCard>
    </div>
  );
}
