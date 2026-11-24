"use client";

import { useEffect, type CSSProperties } from "react";
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
  required,
  autoSelectFirst,
  style,
  ...aria
}: {
  id?: string;
  value: string;
  teams: Array<Pick<Team, "id" | "name">>;
  onChange: (teamId: string) => void;
  disabled?: boolean;
  /** For a picker without a visible <label>. */
  ariaLabel?: string;
  required?: boolean;
  /** Pick the first team once the list is there and nothing is chosen yet (forms that always need a team). */
  autoSelectFirst?: boolean;
  style?: CSSProperties;
  /** Wired by <Field> (hint / error text). */
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}) {
  const t = useT();
  useEffect(() => {
    if (autoSelectFirst && value === "" && teams.length > 0) onChange(teams[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSelectFirst, value, teams.length]);
  return (
    <select id={id} aria-label={ariaLabel} aria-describedby={aria["aria-describedby"]} aria-invalid={aria["aria-invalid"]} required={required} disabled={disabled} value={value} onChange={(e) => onChange(e.target.value)} style={{ ...fieldStyle, minHeight: 44, fontSize: 14, ...style }}>
      {value === "" && <option value="" disabled>{t("pickers.team.select")}</option>}
      {teams.map((tm) => (
        <option key={tm.id} value={tm.id}>{tm.name}</option>
      ))}
    </select>
  );
}
