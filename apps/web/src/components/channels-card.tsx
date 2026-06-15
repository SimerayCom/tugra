"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { CHANNEL_FIELDS } from "../lib/monitors";
import { Btn, Card } from "./ui";

const field: React.CSSProperties = {
  padding: "8px 10px",
  background: "var(--c-el)",
  border: "1px solid var(--c-bd)",
  borderRadius: "var(--r1)",
  color: "var(--c-tx)",
  fontSize: 13,
  fontFamily: "inherit",
};

const TYPES = ["webhook", "telegram", "ntfy", "discord", "slack"];

export function ChannelsCard() {
  const qc = useQueryClient();
  const { data: channels = [] } = useQuery({ queryKey: ["channels"], queryFn: () => api.listChannels() });
  const { data: teams = [] } = useQuery({ queryKey: ["teams"], queryFn: () => api.listTeams() });

  const [name, setName] = useState("");
  const [type, setType] = useState("webhook");
  const [teamId, setTeamId] = useState("");
  const [config, setConfig] = useState<Record<string, string>>({});
  const fields = CHANNEL_FIELDS[type] ?? [];

  const create = useMutation({
    mutationFn: () => api.createChannel({ name, type, teamId: teamId || teams[0]?.id, config }),
    onSuccess: () => {
      setName("");
      setConfig({});
      qc.invalidateQueries({ queryKey: ["channels"] });
    },
  });
  const test = useMutation({
    mutationFn: (id: string) => api.testChannel(id),
    onSuccess: () => alert("Test bildirimi gönderildi ✓"),
    onError: (e) => alert(`Test başarısız: ${(e as Error).message}`),
  });
  const del = useMutation({
    mutationFn: (id: string) => api.deleteChannel(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["channels"] }),
  });

  return (
    <Card style={{ padding: 18, marginTop: 16 }}>
      <div style={{ fontWeight: 600, marginBottom: 12 }}>Bildirim Kanalları</div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 }}>
        {channels.map((c) => (
          <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13 }}>
            <span style={{ fontWeight: 600, flex: 1 }}>{c.name}</span>
            <span style={{ color: "var(--c-tx3)", fontSize: 11 }}>{c.type}</span>
            <Btn variant="ghost" onClick={() => test.mutate(c.id)} style={{ padding: "4px 10px" }}>Test</Btn>
            <Btn variant="ghost" onClick={() => del.mutate(c.id)} style={{ padding: "4px 10px" }}>Sil</Btn>
          </div>
        ))}
        {channels.length === 0 && <div style={{ color: "var(--c-tx3)", fontSize: 13 }}>Henüz kanal yok.</div>}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
        style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}
      >
        <input style={{ ...field, flex: 1, minWidth: 110 }} placeholder="Kanal adı" value={name} onChange={(e) => setName(e.target.value)} required />
        <select style={field} value={type} onChange={(e) => { setType(e.target.value); setConfig({}); }}>
          {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        {fields.map((f) => (
          <input
            key={f}
            style={{ ...field, minWidth: 130 }}
            placeholder={f}
            value={config[f] ?? ""}
            onChange={(e) => setConfig((c) => ({ ...c, [f]: e.target.value }))}
            required={f !== "server"}
          />
        ))}
        <select style={field} value={teamId} onChange={(e) => setTeamId(e.target.value)}>
          <option value="">{teams[0]?.name ?? "Takım"}</option>
          {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <button type="submit" disabled={create.isPending} style={{ ...field, background: "var(--c-a)", color: "#0d0d11", fontWeight: 600, cursor: "pointer" }}>
          {create.isPending ? "…" : "+ Ekle"}
        </button>
      </form>
      {create.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(create.error as Error).message}</div>}
    </Card>
  );
}
