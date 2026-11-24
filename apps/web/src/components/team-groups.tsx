"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useT } from "../i18n/provider";
import { groupByTeam, type TeamLike } from "../lib/team-context";
import { teamColor } from "../lib/team-color";
import { EntityDot } from "./entity-identity";

/**
 * A list split into collapsible team sections (the All-teams view of a multi-team account). With `grouped` off it is
 * a plain pass-through, so a screen renders the same list either way and only the grouping switches.
 */
export function TeamGroups<T extends { teamId: string }>({
  items,
  teams,
  grouped,
  render,
}: {
  items: T[];
  teams: TeamLike[];
  grouped: boolean;
  /** Renders one section's (or the whole) list of items. */
  render: (items: T[]) => ReactNode;
}) {
  const t = useT();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  if (!grouped) return <>{render(items)}</>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {groupByTeam(items, teams).map((g) => {
        const open = !collapsed[g.teamId];
        const label = g.team?.name ?? t("teams.groupUnknown");
        const bodyId = `team-group-${g.teamId}`;
        return (
          <section key={g.teamId} aria-label={label}>
            <button
              type="button"
              aria-expanded={open}
              aria-controls={bodyId}
              onClick={() => setCollapsed((c) => ({ ...c, [g.teamId]: open }))}
              style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", minHeight: 44, padding: "6px 4px", background: "transparent", border: "none", color: "var(--c-tx)", fontFamily: "inherit", fontSize: 13, fontWeight: 700, cursor: "pointer", textAlign: "left" }}
            >
              {open ? <ChevronDown size={16} aria-hidden /> : <ChevronRight size={16} aria-hidden />}
              <EntityDot color={g.team ? teamColor(g.team.id, g.team.color) : null} size={9} />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
              <span style={{ color: "var(--c-tx3)", fontWeight: 500 }}>{g.items.length}</span>
            </button>
            <div id={bodyId} hidden={!open}>{open && render(g.items)}</div>
          </section>
        );
      })}
    </div>
  );
}
