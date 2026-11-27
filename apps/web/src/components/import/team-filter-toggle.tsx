"use client";

import { useT } from "../../i18n/provider";
import type { TeamScope } from "../../lib/import-team";
import { Select } from "../form";
import { Btn } from "../ui";

const ALL = "__all";

/**
 * One block under a step's title when a Coolify team narrows the lists: what it filters in plain words with the counts ("Olgu Bey team:
 * 7 of 28"), a switch between the mapped Coolify teams, and a clear button to reveal the rest. Renders nothing when no team narrows.
 */
export function TeamFilterToggle({
  scope,
  showAll,
  hidden,
  onChange,
  view = null,
  onView,
  onChangeMap,
}: {
  scope: TeamScope | null;
  showAll: boolean;
  hidden: number;
  onChange: (showAll: boolean) => void;
  /** The one mapped Coolify team in view, or null for all the mapped ones. */
  view?: string | null;
  onView?: (ref: string | null) => void;
  /** Reopen the team mapping step. */
  onChangeMap?: () => void;
}) {
  const t = useT();
  if (!scope) return null;
  const mapped = scope.teams.length > 0;
  const headline = showAll
    ? t("import.teamFilter.showingAll")
    : mapped
      ? scope.teamRefs.length === 1
        ? t("import.teamFilter.counts", { team: scope.teamName, shown: scope.shownItems, total: scope.totalItems })
        : t("import.teamFilter.countsAll", { count: scope.teamRefs.length, shown: scope.shownItems, total: scope.totalItems })
      : t("import.teamFilter.showing", { team: scope.teamName });
  return (
    <div data-testid="team-filter" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, margin: "0 0 12px" }}>
      <span role="status" style={{ flex: "1 1 220px", fontSize: 12, color: "var(--c-tx2)", lineHeight: 1.5 }}>
        <strong style={{ display: "block", fontSize: 13, color: "var(--c-tx)" }}>{headline}</strong>
        {mapped && !showAll && t("import.teamFilter.unit")}
      </span>
      {mapped && scope.teams.length > 1 && !showAll && onView && (
        <div style={{ flex: "0 1 260px", minWidth: 0 }}>
          <Select
            ariaLabel={t("import.teamFilter.switcherLabel")}
            value={view && scope.teams.some((x) => x.ref === view) ? view : ALL}
            onChange={(v) => onView(v === ALL ? null : v)}
            options={[{ value: ALL, label: t("import.teamFilter.allMapped", { count: scope.teams.length }) }, ...scope.teams.map((x) => ({ value: x.ref, label: t("import.teamFilter.option", { name: x.name, items: x.items }) }))]}
          />
        </div>
      )}
      {showAll ? (
        <Btn variant="ghost" onClick={() => onChange(false)} style={{ minHeight: 44 }}>{mapped && scope.teamRefs.length > 1 ? t("import.teamFilter.onlyMapped") : t("import.teamFilter.onlyTeam", { team: scope.teamName })}</Btn>
      ) : hidden === 0 ? null : (
        <Btn variant="ghost" onClick={() => onChange(true)} style={{ minHeight: 44 }}>{t("import.teamFilter.showAll", { count: hidden })}</Btn>
      )}
      {mapped && onChangeMap && <Btn variant="ghost" onClick={onChangeMap} style={{ minHeight: 44 }}>{t("import.teamFilter.changeMap")}</Btn>}
    </div>
  );
}
