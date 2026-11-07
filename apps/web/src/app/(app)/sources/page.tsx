"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GitBranch, Trash2 } from "lucide-react";
import { api } from "../../../lib/api";
import type { GitSource, SourceRepo } from "../../../lib/types";
import { useT } from "../../../i18n/provider";
import { Badge, Btn, Card, EmptyState, Spinner } from "../../../components/ui";
import { ErrorState } from "../../../components/error-state";
import { IconBtn } from "../../../components/icon-btn";
import { useConfirm } from "../../../components/confirm";
import { Field, Select, TextInput } from "../../../components/form";

export default function SourcesPage() {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data: teams = [] } = useQuery({ queryKey: ["teams"], queryFn: () => api.listTeams() });
  const { data: sources = [], isLoading, isError, refetch } = useQuery({ queryKey: ["gitSources"], queryFn: () => api.listGitSources() });

  const [teamId, setTeamId] = useState("");
  // Prefer a writable team as the default so a multi-team user sees the create form.
  const activeTeam = teamId || teams.find((tm) => tm.role !== "VIEWER")?.id || teams[0]?.id || "";
  const canCreate = teams.some((tm) => tm.id === activeTeam && tm.role !== "VIEWER");
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

  // Gitea / Forgejo / Codeberg (token) form. The token is write-only: it is cleared right after a successful save.
  const [tKind, setTKind] = useState<"gitea" | "forgejo" | "codeberg">("gitea");
  const [tName, setTName] = useState("");
  const [tUrl, setTUrl] = useState("");
  const [tToken, setTToken] = useState("");
  const tReady = !!tName && !!tToken && !!activeTeam && (tKind === "codeberg" || !!tUrl);
  const createToken = useMutation({
    mutationFn: () => api.createGitSource({ kind: tKind, name: tName, teamId: activeTeam, apiUrl: tKind === "codeberg" ? undefined : tUrl.trim(), token: tToken }),
    onSuccess: () => { setTName(""); setTUrl(""); setTToken(""); invalidate(); },
  });

  return (
    <div style={{ padding: "var(--page-pad)", maxWidth: 880 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 4px", display: "flex", alignItems: "center", gap: 8 }}>
        <GitBranch size={20} color="var(--c-a)" /> {t("sources.title")}
      </h1>
      <p style={{ color: "var(--c-tx3)", fontSize: 14, margin: "0 0 22px" }}>{t("sources.subtitle")}</p>

      {isError && sources.length === 0 ? (
        <ErrorState onRetry={() => refetch()} />
      ) : isLoading ? (
        <Spinner />
      ) : sources.length === 0 ? (
        <Card style={{ marginBottom: 20 }}><EmptyState icon={GitBranch} title={t("sources.emptyTitle")}>{t("sources.noSources")}</EmptyState></Card>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 24 }}>
          {sources.map((s) => <SourceRow key={s.id} source={s} onDelete={async () => { if (await confirm({ body: t("common.deleteConfirm"), danger: true })) del.mutate(s.id); }} />)}
        </div>
      )}

      {canCreate && (
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
      )}

      {canCreate && (
      <Card style={{ padding: 16, marginTop: 16 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--c-tx3)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>{t("sources.createToken")}</div>
        <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>{t("sources.howtoToken")}</p>
        <form autoComplete="off" onSubmit={(e) => { e.preventDefault(); if (tReady) createToken.mutate(); }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
            <Field label={t("sources.provider")}>
              <Select value={tKind} onChange={(v) => setTKind(v as "gitea" | "forgejo" | "codeberg")} options={[{ value: "gitea", label: "Gitea" }, { value: "forgejo", label: "Forgejo" }, { value: "codeberg", label: "Codeberg" }]} />
            </Field>
            <Field label={t("sources.name")} htmlFor="gt-name"><TextInput id="gt-name" value={tName} onChange={(e) => setTName(e.target.value)} required /></Field>
            <Field label={t("sources.team")}><Select value={activeTeam} onChange={setTeamId} options={teams.map((tm) => ({ value: tm.id, label: tm.name }))} /></Field>
            <Field label={t("sources.baseUrl")} hint={tKind === "codeberg" ? t("sources.codebergUrl") : t("sources.baseUrlHint")} htmlFor="gt-url">
              <TextInput id="gt-url" value={tKind === "codeberg" ? "https://codeberg.org" : tUrl} onChange={(e) => setTUrl(e.target.value)} placeholder="https://git.example.com" disabled={tKind === "codeberg"} required={tKind !== "codeberg"} />
            </Field>
            <Field label={t("sources.token")} hint={t("sources.tokenHint")} htmlFor="gt-token">
              <TextInput id="gt-token" type="password" autoComplete="new-password" value={tToken} onChange={(e) => setTToken(e.target.value)} required />
            </Field>
          </div>
          <div style={{ marginTop: 12 }}>
            <Btn type="submit" disabled={createToken.isPending || !tReady}>{createToken.isPending ? "…" : t("sources.connect")}</Btn>
          </div>
          {createToken.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(createToken.error as Error).message}</div>}
        </form>
      </Card>
      )}
    </div>
  );
}

function SourceRow({ source, onDelete }: { source: GitSource; onDelete: () => void }) {
  const t = useT();
  const { id, name, appId, installationId, canWrite, kind, apiUrl, hasToken } = source;
  const [repos, setRepos] = useState<SourceRepo[] | null>(null);
  const load = useMutation({ mutationFn: () => api.listSourceRepos(id), onSuccess: (r) => setRepos(r) });
  const kindLabel = kind === "github" ? t("sources.githubApp") : kind === "gitea" ? "Gitea" : kind === "forgejo" ? "Forgejo" : "Codeberg";
  return (
    <Card style={{ padding: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontWeight: 600, fontSize: 14 }}>{name}</span>
            <Badge tone="gold">{kindLabel}</Badge>
            {hasToken && <Badge tone="ok">{t("sources.connected")}</Badge>}
          </div>
          <div className="mono" style={{ fontSize: 11, color: "var(--c-tx3)", marginTop: 3, overflowWrap: "anywhere" }}>
            {kind === "github" ? <>app {appId}{installationId ? ` · inst ${installationId}` : ""}</> : apiUrl}
          </div>
        </div>
        {canWrite && (
          <>
            <Btn variant="ghost" onClick={() => load.mutate()} disabled={load.isPending}>{load.isPending ? "…" : t("sources.loadRepos")}</Btn>
            <IconBtn label={t("sources.delete")} danger onClick={onDelete}><Trash2 size={15} /></IconBtn>
          </>
        )}
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
