"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../../lib/api";
import { useT } from "../../../../i18n/provider";
import { BackLink, Btn } from "../../../../components/ui";
import { Field, Select, TextInput } from "../../../../components/form";

export default function NewServerPage() {
  const t = useT();
  const router = useRouter();
  const { data: teams = [] } = useQuery({ queryKey: ["teams"], queryFn: () => api.listTeams() });
  const [name, setName] = useState("");
  const [teamId, setTeamId] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      const res = await api.createServer(name, teamId);
      // The install + wait experience lives at a stable, refresh-safe URL.
      router.replace(`/servers/${res.server.id}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("servers.createFailed"));
      setBusy(false);
    }
  };

  return (
    <div style={{ padding: "var(--page-pad)", maxWidth: 480 }}>
      <BackLink href="/servers" label={t("common.backTo", { target: t("nav.servers") })} />
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 16px" }}>{t("servers.newTitle")}</h1>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <Field label={t("servers.name")} htmlFor="srv-name">
          <TextInput id="srv-name" value={name} onChange={(e) => setName(e.target.value)} required />
        </Field>
        <Field label={t("common.team")}>
          <Select value={teamId} onChange={setTeamId} autoSelectFirst required placeholder={t("common.pickTeam")}
            options={teams.map((tm) => ({ value: tm.id, label: `${tm.name} (${tm.role})` }))} />
        </Field>
        {err && <div style={{ color: "var(--c-r)", fontSize: 13 }}>{err}</div>}
        <div><Btn type="submit" disabled={busy}>{busy ? "…" : t("servers.create")}</Btn></div>
      </form>
    </div>
  );
}
