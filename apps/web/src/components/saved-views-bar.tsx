"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useT } from "../i18n/provider";
import type { SavedView, ServerStatus } from "../lib/types";
import { Btn } from "./ui";

/** Personal named fleet filters: save current status+tags, re-apply, delete. */
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
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const invalidate = () => qc.invalidateQueries({ queryKey: ["savedViews"] });
  const create = useMutation({
    mutationFn: () => api.createSavedView({ name: name.trim(), status, tags }),
    onSuccess: () => { setName(""); setSaving(false); invalidate(); },
  });
  const del = useMutation({ mutationFn: (id: string) => api.deleteSavedView(id), onSuccess: invalidate });

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
      {views.map((v) => (
        <span key={v.id} style={{ display: "inline-flex", alignItems: "center", gap: 2, fontSize: 12, border: "1px solid var(--c-bd)", borderRadius: 999, padding: "2px 4px 2px 11px" }}>
          <button type="button" onClick={() => onApply(v)} style={{ background: "transparent", border: "none", color: "var(--c-tx2)", fontSize: 12, cursor: "pointer", fontFamily: "inherit", padding: 0 }}>{v.name}</button>
          <button type="button" aria-label={t("common.delete")} onClick={() => del.mutate(v.id)} style={{ background: "transparent", border: "none", color: "var(--c-tx3)", cursor: "pointer", lineHeight: 1, padding: "0 4px", fontSize: 14 }}>×</button>
        </span>
      ))}
      {saving ? (
        <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) create.mutate(); }} style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("servers.viewName")}
            maxLength={40}
            style={{ fontSize: 12, padding: "4px 10px", background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: 999, color: "var(--c-tx)" }}
          />
          <Btn type="submit" variant="ghost" disabled={!name.trim() || create.isPending}>{t("servers.save")}</Btn>
          <button type="button" onClick={() => { setSaving(false); setName(""); }} style={{ background: "transparent", border: "none", color: "var(--c-tx3)", cursor: "pointer", fontSize: 12, fontFamily: "inherit" }}>{t("bulk.close")}</button>
        </form>
      ) : (
        <button type="button" onClick={() => setSaving(true)} style={{ fontSize: 12, border: "1px dashed var(--c-bd)", borderRadius: 999, padding: "3px 11px", background: "transparent", color: "var(--c-tx3)", cursor: "pointer", fontFamily: "inherit" }}>+ {t("servers.saveView")}</button>
      )}
    </div>
  );
}
