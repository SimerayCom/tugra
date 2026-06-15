"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../../lib/api";
import { useT } from "../../../../i18n/provider";
import { Btn, Card, Spinner, StatusDot } from "../../../../components/ui";

const field: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  background: "var(--c-el)",
  border: "1px solid var(--c-bd)",
  borderRadius: "var(--r1)",
  color: "var(--c-tx)",
  fontSize: 14,
  fontFamily: "inherit",
  marginBottom: 12,
};

export default function NewServerPage() {
  const t = useT();
  const { data: teams = [] } = useQuery({ queryKey: ["teams"], queryFn: () => api.listTeams() });
  const [name, setName] = useState("");
  const [teamId, setTeamId] = useState("");
  const [created, setCreated] = useState<{ id: string; command: string } | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const { data: server } = useQuery({
    queryKey: ["server", created?.id],
    queryFn: () => api.getServer(created!.id),
    enabled: !!created,
    refetchInterval: 3000,
  });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      const res = await api.createServer(name, teamId || teams[0]?.id);
      setCreated({ id: res.server.id, command: res.installCommand });
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("servers.createFailed"));
    }
    setBusy(false);
  };

  if (created) {
    return (
      <div style={{ padding: 28, maxWidth: 640 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 16px" }}>{t("servers.installTitle")}</h1>
        <Card style={{ padding: 16, marginBottom: 16 }}>
          <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 8 }}>{t("servers.installDesc")}</div>
          <pre className="mono" style={{ background: "var(--c-el)", padding: 12, borderRadius: "var(--r1)", fontSize: 12, overflowX: "auto", margin: 0 }}>
            {created.command}
          </pre>
          <Btn variant="ghost" style={{ marginTop: 10 }} onClick={() => navigator.clipboard?.writeText(created.command)}>
            {t("servers.copy")}
          </Btn>
        </Card>
        <Card style={{ padding: 16, display: "flex", alignItems: "center", gap: 10 }}>
          {server?.status === "ONLINE" ? (
            <>
              <StatusDot status="ONLINE" />
              <span style={{ fontWeight: 600 }}>{t("servers.connected")}</span>
            </>
          ) : (
            <>
              <Spinner />
              <span style={{ color: "var(--c-tx3)" }}>{t("servers.waiting")}</span>
            </>
          )}
        </Card>
      </div>
    );
  }

  return (
    <div style={{ padding: 28, maxWidth: 480 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 16px" }}>{t("servers.newTitle")}</h1>
      <form onSubmit={submit}>
        <input style={field} placeholder={t("servers.name")} value={name} onChange={(e) => setName(e.target.value)} required />
        <select style={field} value={teamId} onChange={(e) => setTeamId(e.target.value)}>
          <option value="">{teams[0]?.name ?? t("common.pickTeam")}</option>
          {teams.map((tm) => (
            <option key={tm.id} value={tm.id}>{tm.name} ({tm.role})</option>
          ))}
        </select>
        {err && <div style={{ color: "var(--c-r)", fontSize: 13, marginBottom: 10 }}>{err}</div>}
        <Btn type="submit" disabled={busy}>{busy ? "…" : t("servers.create")}</Btn>
      </form>
    </div>
  );
}
