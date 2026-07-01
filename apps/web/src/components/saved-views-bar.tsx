"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Users } from "lucide-react";
import { api } from "../lib/api";
import { teamLabel } from "../lib/fleet";
import { useT } from "../i18n/provider";
import type { SavedView, ServerStatus } from "../lib/types";
import { Btn } from "./ui";

/** Named fleet filters: save current status+tags (personal or shared with a team), re-apply, delete. */
export function SavedViewsBar({
  status,
  tags,
  onApply,
}: {
  status: ServerStatus | null;
  tags: string[];
  onApply: (v: SavedView) => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const { data: views = [] } = useQuery({ queryKey: ["savedViews"], queryFn: () => api.listSavedViews() });
  const { data: teams = [] } = useQuery({ queryKey: ["teams"], queryFn: () => api.listTeams() });
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [target, setTarget] = useState(""); // "" = personal, else teamId

  const invalidate = () => qc.invalidateQueries({ queryKey: ["savedViews"] });
  const create = useMutation({
    mutationFn: () => api.createSavedView({ name: name.trim(), status, tags, teamId: target || undefined }),
    onSuccess: () => { setName(""); setTarget(""); setSaving(false); invalidate(); },
  });
  const del = useMutation({ mutationFn: (id: string) => api.deleteSavedView(id), onSuccess: invalidate });

  const inputStyle: React.CSSProperties = { fontSize: 12, padding: "4px 10px", background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: 999, color: "var(--c-tx)" };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
      {views.map((v) => (
        <span key={v.id} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, border: "1px solid var(--c-bd)", borderRadius: 999, padding: "2px 4px 2px 11px" }}>
          {v.teamId && <Users size={11} color="var(--c-tx3)" aria-label={teamLabel(teams, v.teamId)} />}
          <button type="button" onClick={() => onApply(v)} title={v.teamId ? teamLabel(teams, v.teamId) : undefined} style={{ background: "transparent", border: "none", color: "var(--c-tx2)", fontSize: 12, cursor: "pointer", fontFamily: "inherit", padding: 0 }}>{v.name}</button>
          {v.canDelete && (
            <button type="button" aria-label={t("common.delete")} onClick={() => del.mutate(v.id)} style={{ background: "transparent", border: "none", color: "var(--c-tx3)", cursor: "pointer", lineHeight: 1, padding: "0 4px", fontSize: 14 }}>×</button>
          )}
        </span>
      ))}
      {saving ? (
        <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) create.mutate(); }} style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t("servers.viewName")} maxLength={40} style={inputStyle} />
          {teams.length > 0 && (
            <select value={target} onChange={(e) => setTarget(e.target.value)} aria-label={t("servers.viewShareWith")} style={inputStyle}>
              <option value="">{t("servers.viewPersonal")}</option>
              {teams.map((tm) => <option key={tm.id} value={tm.id}>{tm.name}</option>)}
            </select>
          )}
          <Btn type="submit" variant="ghost" disabled={!name.trim() || create.isPending}>{t("servers.save")}</Btn>
          <button type="button" onClick={() => { setSaving(false); setName(""); setTarget(""); }} style={{ background: "transparent", border: "none", color: "var(--c-tx3)", cursor: "pointer", fontSize: 12, fontFamily: "inherit" }}>{t("bulk.close")}</button>
        </form>
      ) : (
        <button type="button" onClick={() => setSaving(true)} style={{ fontSize: 12, border: "1px dashed var(--c-bd)", borderRadius: 999, padding: "3px 11px", background: "transparent", color: "var(--c-tx3)", cursor: "pointer", fontFamily: "inherit" }}>+ {t("servers.saveView")}</button>
      )}
    </div>
  );
}
