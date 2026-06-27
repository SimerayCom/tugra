"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GitBranch, Trash2 } from "lucide-react";
import { api } from "../../../lib/api";
import type { SourceRepo } from "../../../lib/types";
import { useT } from "../../../i18n/provider";
import { Badge, Btn, Card, EmptyState, Spinner } from "../../../components/ui";
import { IconBtn } from "../../../components/icon-btn";
import { Field, Select, TextInput } from "../../../components/form";

export default function SourcesPage() {
  const t = useT();
  const qc = useQueryClient();
  const { data: teams = [] } = useQuery({ queryKey: ["teams"], queryFn: () => api.listTeams() });
  const { data: sources = [], isLoading } = useQuery({ queryKey: ["gitSources"], queryFn: () => api.listGitSources() });

  const [teamId, setTeamId] = useState("");
  const activeTeam = teamId || teams[0]?.id || "";
  const [name, setName] = useState("");
  const [appId, setAppId] = useState("");
  const [installationId, setInstallationId] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");

  const invalidate = () => qc.invalidateQueries({ queryKey: ["gitSources"] });
  const create = useMutation({
    mutationFn: () => api.createGitSource({ name, teamId: activeTeam, appId, privateKey, installationId: installationId || undefined, webhookSecret: webhookSecret || undefined }),
    onSuccess: () => { setName(""); setAppId(""); setInstallationId(""); setPrivateKey(""); setWebhookSecret(""); invalidate(); },
  });
  const del = useMutation({ mutationFn: (id: string) => api.deleteGitSource(id), onSuccess: invalidate });

  return (
    <div style={{ padding: "var(--page-pad)", maxWidth: 880 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 4px", display: "flex", alignItems: "center", gap: 8 }}>
        <GitBranch size={20} color="var(--c-a)" /> {t("sources.title")}
      </h1>
      <p style={{ color: "var(--c-tx3)", fontSize: 14, margin: "0 0 22px" }}>{t("sources.subtitle")}</p>

      {isLoading ? (
        <Spinner />
      ) : sources.length === 0 ? (
        <Card style={{ padding: 16, marginBottom: 20 }}><EmptyState>{t("sources.noSources")}</EmptyState></Card>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 24 }}>
          {sources.map((s) => <SourceRow key={s.id} id={s.id} name={s.name} appId={s.appId} installationId={s.installationId} onDelete={() => del.mutate(s.id)} />)}
        </div>
      )}

      <Card style={{ padding: 16 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--c-tx3)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>{t("sources.create")}</div>
        <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>{t("sources.howto")}</p>
        <form onSubmit={(e) => { e.preventDefault(); if (name && appId && privateKey && activeTeam) create.mutate(); }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
            <Field label={t("sources.name")} htmlFor="gs-name"><TextInput id="gs-name" value={name} onChange={(e) => setName(e.target.value)} required /></Field>
            <Field label={t("sources.team")}><Select value={activeTeam} onChange={setTeamId} options={teams.map((tm) => ({ value: tm.id, label: tm.name }))} /></Field>
            <Field label={t("sources.appId")}><TextInput value={appId} onChange={(e) => setAppId(e.target.value)} required /></Field>
            <Field label={t("sources.installationId")}><TextInput value={installationId} onChange={(e) => setInstallationId(e.target.value)} /></Field>
            <Field label={t("sources.webhookSecret")}><TextInput type="password" value={webhookSecret} onChange={(e) => setWebhookSecret(e.target.value)} /></Field>
          </div>
          <Field label={t("sources.privateKey")} style={{ marginTop: 12 }}>
            <textarea
              value={privateKey}
              onChange={(e) => setPrivateKey(e.target.value)}
              required
              placeholder="-----BEGIN PRIVATE KEY-----"
              style={{ width: "100%", minHeight: 120, padding: "8px 10px", background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", color: "var(--c-tx)", fontSize: 12, fontFamily: "var(--font-mono, monospace)", resize: "vertical", boxSizing: "border-box" }}
            />
          </Field>
          <div style={{ marginTop: 12 }}>
            <Btn type="submit" disabled={create.isPending || !name || !appId || !privateKey || !activeTeam}>{create.isPending ? "…" : t("sources.add")}</Btn>
          </div>
          {create.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(create.error as Error).message}</div>}
        </form>
      </Card>
    </div>
  );
}

function SourceRow({ id, name, appId, installationId, onDelete }: { id: string; name: string; appId: string; installationId: string | null; onDelete: () => void }) {
  const t = useT();
  const [repos, setRepos] = useState<SourceRepo[] | null>(null);
  const load = useMutation({ mutationFn: () => api.listSourceRepos(id), onSuccess: (r) => setRepos(r) });
  return (
    <Card style={{ padding: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontWeight: 600, fontSize: 14 }}>{name}</span>
            <Badge tone="gold">GitHub App</Badge>
          </div>
          <div className="mono" style={{ fontSize: 11, color: "var(--c-tx3)", marginTop: 3 }}>
            app {appId}{installationId ? ` · inst ${installationId}` : ""}
          </div>
        </div>
        <Btn variant="ghost" onClick={() => load.mutate()} disabled={load.isPending}>{load.isPending ? "…" : t("sources.loadRepos")}</Btn>
        <IconBtn label={t("sources.delete")} danger onClick={onDelete}><Trash2 size={15} /></IconBtn>
      </div>
      {repos && (
        <div style={{ marginTop: 10, fontSize: 12, color: "var(--c-tx2)" }}>
          {repos.length === 0 ? "—" : repos.map((r) => r.fullName).join(", ")}
        </div>
      )}
      {load.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(load.error as Error).message}</div>}
    </Card>
  );
}
