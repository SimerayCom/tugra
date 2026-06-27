"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import { useT } from "../../../i18n/provider";
import { Btn, Card, Spinner } from "../../../components/ui";
import { useConfirm } from "../../../components/confirm";

const field: React.CSSProperties = {
  padding: "8px 10px",
  background: "var(--c-el)",
  border: "1px solid var(--c-bd)",
  borderRadius: "var(--r1)",
  color: "var(--c-tx)",
  fontSize: 13,
  fontFamily: "inherit",
};

export default function SharedVariablesPage() {
  const t = useT();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const { data: teams = [] } = useQuery({ queryKey: ["teams"], queryFn: () => api.listTeams() });
  const [teamId, setTeamId] = useState("");
  const activeTeam = teamId || teams[0]?.id || "";

  const { data: vars = [], isLoading } = useQuery({
    queryKey: ["sharedVars", activeTeam],
    queryFn: () => api.listSharedVars(activeTeam),
    enabled: !!activeTeam,
  });

  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [reveal, setReveal] = useState(false);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["sharedVars", activeTeam] });
  const save = useMutation({
    mutationFn: () => api.setSharedVar(activeTeam, key, value),
    onSuccess: () => { setKey(""); setValue(""); invalidate(); },
  });
  const del = useMutation({ mutationFn: (id: string) => api.deleteSharedVar(id), onSuccess: invalidate });

  return (
    <div style={{ padding: "var(--page-pad)", maxWidth: 720 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 4px" }}>{t("shared.title")}</h1>
      <p style={{ color: "var(--c-tx3)", fontSize: 14, margin: "0 0 22px" }}>{t("shared.subtitle")}</p>

      <Card style={{ padding: 16, marginBottom: 20 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
          <span style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("shared.team")}</span>
          <select style={field} value={activeTeam} onChange={(e) => setTeamId(e.target.value)}>
            {teams.map((tm) => <option key={tm.id} value={tm.id}>{tm.name}</option>)}
          </select>
          <div style={{ flex: 1 }} />
          <button onClick={() => setReveal((v) => !v)} style={{ ...field, cursor: "pointer", border: "none", background: "transparent", color: "var(--c-tx3)" }}>
            {reveal ? t("shared.hide") : t("shared.reveal")}
          </button>
        </div>
        <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }} style={{ display: "flex", gap: 8 }}>
          <input style={{ ...field, width: 220 }} placeholder={t("shared.key")} value={key} onChange={(e) => setKey(e.target.value)} required />
          <input style={{ ...field, flex: 1 }} type={reveal ? "text" : "password"} placeholder={t("shared.value")} value={value} onChange={(e) => setValue(e.target.value)} />
          <Btn onClick={() => save.mutate()} disabled={save.isPending || !key || !activeTeam}>{t("shared.add")}</Btn>
        </form>
        {save.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(save.error as Error).message}</div>}
      </Card>

      {isLoading ? (
        <Spinner />
      ) : (
        <div style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r2)", overflow: "hidden" }}>
          {vars.map((v) => (
            <div key={v.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 16px", borderTop: "1px solid var(--c-bd)" }}>
              <span className="mono" style={{ fontWeight: 600, fontSize: 13, width: 220 }}>{v.key}</span>
              <code className="mono" style={{ flex: 1, fontSize: 12, color: "var(--c-tx2)" }}>
                {reveal ? (v.value ?? "—") : "••••••••"}
              </code>
              <button onClick={async () => { if (await confirm({ body: t("common.deleteConfirm"), danger: true })) del.mutate(v.id); }} style={{ background: "transparent", border: "none", color: "var(--c-r)", fontSize: 12, cursor: "pointer" }}>{t("shared.delete")}</button>
            </div>
          ))}
          {vars.length === 0 && <div style={{ padding: 32, textAlign: "center", color: "var(--c-tx3)", fontSize: 13 }}>{t("shared.empty")}</div>}
        </div>
      )}
    </div>
  );
}
