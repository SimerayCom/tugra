"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cloud, Pencil, Trash2 } from "lucide-react";
import { api } from "../../../lib/api";
import { useT } from "../../../i18n/provider";
import { Badge, Btn, Card, EmptyState, Spinner } from "../../../components/ui";
import { ErrorState } from "../../../components/error-state";
import { IconBtn } from "../../../components/icon-btn";
import { useConfirm } from "../../../components/confirm";
import { Field, Select, TextInput } from "../../../components/form";

export default function CloudCredentialsPage() {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data: teams = [] } = useQuery({ queryKey: ["teams"], queryFn: () => api.listTeams() });
  const { data: creds = [], isLoading, isError, refetch } = useQuery({ queryKey: ["cloudCredentials"], queryFn: () => api.listCloudCredentials() });

  const [teamId, setTeamId] = useState("");
  const activeTeam = teamId || teams.find((tm) => tm.role !== "VIEWER")?.id || teams[0]?.id || "";
  const canCreate = teams.some((tm) => tm.id === activeTeam && tm.role !== "VIEWER");
  const [name, setName] = useState("");
  const [apiToken, setApiToken] = useState("");

  const invalidate = () => qc.invalidateQueries({ queryKey: ["cloudCredentials"] });
  const create = useMutation({
    mutationFn: () => api.createCloudCredential({ name, teamId: activeTeam, provider: "hetzner", apiToken }),
    onSuccess: () => { setName(""); setApiToken(""); invalidate(); },
  });
  const del = useMutation({ mutationFn: (id: string) => api.deleteCloudCredential(id), onSuccess: invalidate });

  return (
    <div style={{ padding: "var(--page-pad)", maxWidth: 880 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 4px", display: "flex", alignItems: "center", gap: 8 }}>
        <Cloud size={20} color="var(--c-a)" /> {t("cloudCredentials.title")}
      </h1>
      <p style={{ color: "var(--c-tx3)", fontSize: 14, margin: "0 0 22px" }}>{t("cloudCredentials.subtitle")}</p>

      {isError && creds.length === 0 ? (
        <ErrorState onRetry={() => refetch()} />
      ) : isLoading ? (
        <Spinner />
      ) : creds.length === 0 ? (
        <Card style={{ marginBottom: 20 }}><EmptyState icon={Cloud} title={t("cloudCredentials.emptyTitle")}>{t("cloudCredentials.empty")}</EmptyState></Card>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 24 }}>
          {creds.map((c) => (
            <CredentialRow
              key={c.id}
              id={c.id}
              name={c.name}
              provider={c.provider}
              canWrite={c.canWrite}
              onDelete={async () => { if (await confirm({ body: t("common.deleteConfirm"), danger: true })) del.mutate(c.id); }}
            />
          ))}
        </div>
      )}

      {canCreate && (
        <Card style={{ padding: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--c-tx3)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>{t("cloudCredentials.create")}</div>
          <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>{t("cloudCredentials.howto")}</p>
          <form onSubmit={(e) => { e.preventDefault(); if (name && apiToken && activeTeam) create.mutate(); }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
              <Field label={t("cloudCredentials.name")} htmlFor="cc-name"><TextInput id="cc-name" value={name} onChange={(e) => setName(e.target.value)} required /></Field>
              <Field label={t("cloudCredentials.team")}><Select value={activeTeam} onChange={setTeamId} options={teams.map((tm) => ({ value: tm.id, label: tm.name }))} /></Field>
              <Field label={t("cloudCredentials.provider")}><div style={{ paddingTop: 6 }}><Badge tone="gold">Hetzner</Badge></div></Field>
              <Field label={t("cloudCredentials.apiToken")} htmlFor="cc-token" hint={t("cloudCredentials.apiTokenHint")}><TextInput id="cc-token" type="password" value={apiToken} onChange={(e) => setApiToken(e.target.value)} required /></Field>
            </div>
            <div style={{ marginTop: 12 }}>
              <Btn type="submit" disabled={create.isPending || !name || !apiToken || !activeTeam}>{create.isPending ? "…" : t("cloudCredentials.add")}</Btn>
            </div>
            {create.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(create.error as Error).message}</div>}
          </form>
        </Card>
      )}
    </div>
  );
}

function CredentialRow({
  id, name, provider, canWrite, onDelete,
}: { id: string; name: string; provider: string; canWrite: boolean; onDelete: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const test = useMutation({ mutationFn: () => api.testCloudCredential(id) });
  const [editing, setEditing] = useState(false);
  const [eName, setEName] = useState(name);
  const [eToken, setEToken] = useState("");
  const openEdit = () => { setEName(name); setEToken(""); setEditing(true); };
  const update = useMutation({
    // apiToken is write-only: only send it when the operator typed a new one (blank keeps the current one).
    mutationFn: () => api.updateCloudCredential(id, { name: eName, ...(eToken ? { apiToken: eToken } : {}) }),
    onSuccess: () => { setEditing(false); setEToken(""); qc.invalidateQueries({ queryKey: ["cloudCredentials"] }); },
  });
  return (
    <Card style={{ padding: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontWeight: 600, fontSize: 14 }}>{name}</span>
            <Badge tone="gold">{provider}</Badge>
          </div>
        </div>
        {canWrite && (
          <>
            <Btn variant="ghost" onClick={() => test.mutate()} disabled={test.isPending}>{test.isPending ? "…" : t("cloudCredentials.test")}</Btn>
            <IconBtn label={t("cloudCredentials.edit")} onClick={() => (editing ? setEditing(false) : openEdit())}><Pencil size={15} /></IconBtn>
            <IconBtn label={t("cloudCredentials.delete")} danger onClick={onDelete}><Trash2 size={15} /></IconBtn>
          </>
        )}
      </div>
      {editing && canWrite && (
        <form onSubmit={(e) => { e.preventDefault(); if (eName) update.mutate(); }} style={{ marginTop: 12, borderTop: "1px solid var(--c-bd)", paddingTop: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
            <Field label={t("cloudCredentials.name")}><TextInput value={eName} onChange={(e) => setEName(e.target.value)} required /></Field>
            <Field label={t("cloudCredentials.apiToken")} hint={t("cloudCredentials.apiTokenKeep")}><TextInput type="password" value={eToken} onChange={(e) => setEToken(e.target.value)} placeholder="••••••" /></Field>
          </div>
          <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
            <Btn type="submit" disabled={update.isPending || !eName}>{update.isPending ? "…" : t("common.save")}</Btn>
            <Btn variant="ghost" onClick={() => setEditing(false)}>{t("common.cancel")}</Btn>
          </div>
          {update.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(update.error as Error).message}</div>}
        </form>
      )}
      {test.isSuccess && <div style={{ color: "var(--c-g)", fontSize: 12, marginTop: 8 }}>{t("cloudCredentials.testOk")}</div>}
      {test.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(test.error as Error).message}</div>}
    </Card>
  );
}
