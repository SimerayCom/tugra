"use client";

import type { CSSProperties } from "react";
import { useT } from "../i18n/provider";
import { fieldStyle } from "./form";
import type { Team } from "../lib/types";

/** The one team chooser: the same dropdown design as the project picker. Pass only the teams that make sense on the screen. */
export function TeamPicker({
  id,
  value,
  teams,
  onChange,
  disabled,
  ariaLabel,
  style,
}: {
  id?: string;
  value: string;
  teams: Array<Pick<Team, "id" | "name">>;
  onChange: (teamId: string) => void;
  disabled?: boolean;
  /** For a picker without a visible <label>. */
  ariaLabel?: string;
  style?: CSSProperties;
}) {
  const t = useT();
  return (
    <select id={id} aria-label={ariaLabel} disabled={disabled} value={value} onChange={(e) => onChange(e.target.value)} style={{ ...fieldStyle, minHeight: 44, fontSize: 14, ...style }}>
      {value === "" && <option value="" disabled>{t("pickers.team.select")}</option>}
      {teams.map((tm) => (
        <option key={tm.id} value={tm.id}>{tm.name}</option>
      ))}
    </select>
  );
}
