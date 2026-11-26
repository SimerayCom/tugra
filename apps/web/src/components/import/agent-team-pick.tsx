"use client";

import { useT } from "../../i18n/provider";
import type { ImportAgentSession } from "../../lib/types";
import { Select } from "../form";

/**
 * A Coolify with several teams that have projects: the owner says which team's settings (notifications, shared variables, tags, members)
 * the session reads. No team is pre-picked and nothing is chosen for them; the projects of every team are in the plan either way.
 */
export function AgentTeamPick({ teams, value, onChange, disabled, id = "agent-team" }: { teams: NonNullable<ImportAgentSession["teams"]>; value: string; onChange: (ref: string) => void; disabled?: boolean; id?: string }) {
  const t = useT();
  return (
    <div data-testid="agent-team-pick" style={{ display: "grid", gap: 6 }}>
      <label htmlFor={id} style={{ fontSize: 12, fontWeight: 600, color: "var(--c-tx2)" }}>{t("coolifyAgent.team.label")}</label>
      <Select id={id} value={value} onChange={onChange} disabled={disabled} placeholder={t("coolifyAgent.team.placeholder")} options={teams.map((tm) => ({ value: tm.ref, label: tm.name }))} style={{ maxWidth: 420 }} />
      <p style={{ margin: 0, fontSize: 12, color: "var(--c-tx3)", lineHeight: 1.5 }}>{t("coolifyAgent.team.hint")}</p>
    </div>
  );
}
