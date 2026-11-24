"use client";

import { Users } from "lucide-react";
import { teamIconUrl } from "../lib/api";
import { teamColor } from "../lib/team-color";

/** Team name with its colour and icon (the uploaded team icon, or a neutral glyph). Colour is decoration: the name is always shown. */
export function TeamChip({ team, fallbackName }: { team: { id: string; name: string; iconUpdatedAt?: string | null } | undefined; fallbackName: string }) {
  const id = team?.id ?? fallbackName;
  const color = teamColor(id);
  const icon = team ? teamIconUrl(team.id, team.iconUpdatedAt) : null;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, padding: "2px 8px 2px 4px", borderRadius: 6, background: `${color}22`, color, fontWeight: 600, maxWidth: 180 }}>
      <span style={{ width: 16, height: 16, borderRadius: 4, background: `${color}33`, display: "inline-flex", alignItems: "center", justifyContent: "center", overflow: "hidden", flex: "none" }}>
        {icon ? <img src={icon} alt="" width={16} height={16} style={{ objectFit: "cover" }} /> : <Users size={11} aria-hidden="true" />}
      </span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{team?.name ?? fallbackName}</span>
    </span>
  );
}
