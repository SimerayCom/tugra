"use client";

import { useT } from "../../i18n/provider";
import type { TeamScope } from "../../lib/import-team";
import { Btn } from "../ui";

/**
 * One line under a step's title when the owner picked a Coolify team that is not the only one: what the lists show, and a clear
 * button to reveal the rest. Renders nothing when no team narrows the lists.
 */
export function TeamFilterToggle({ scope, showAll, hidden, onChange }: { scope: TeamScope | null; showAll: boolean; hidden: number; onChange: (showAll: boolean) => void }) {
  const t = useT();
  if (!scope) return null;
  return (
    <div data-testid="team-filter" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, margin: "0 0 12px" }}>
      <span role="status" style={{ flex: "1 1 220px", fontSize: 12, color: "var(--c-tx2)", lineHeight: 1.5 }}>
        {showAll ? t("import.teamFilter.showingAll") : t("import.teamFilter.showing", { team: scope.teamName })}
      </span>
      {showAll ? (
        <Btn variant="ghost" onClick={() => onChange(false)} style={{ minHeight: 44 }}>{t("import.teamFilter.onlyTeam", { team: scope.teamName })}</Btn>
      ) : (
        <Btn variant="ghost" onClick={() => onChange(true)} style={{ minHeight: 44 }}>{t("import.teamFilter.showAll", { count: hidden })}</Btn>
      )}
    </div>
  );
}
