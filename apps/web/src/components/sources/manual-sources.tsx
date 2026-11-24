"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useT } from "../../i18n/provider";
import { Btn, Card } from "../ui";
import { Field, Select, TextInput } from "../form";
import { PemDrop } from "./pem-drop";

type TeamLite = { id: string; name: string; role: string };

/** "Advanced": for a GitHub App the user created by hand (IDs + a dropped .pem) and for token providers. */
export function ManualSources({ teams }: { teams: TeamLite[] }) {
  const t = useT();
  const qc = useQueryClient();
  const writable = teams.filter((tm) => tm.role !== "VIEWER");
  const [teamId, setTeamId] = useState(writable.length === 1 ? writable[0].id : "");
  const invalidate = () => qc.invalidateQueries({ queryKey: ["gitSources"] });
  const teamField = (id: string) => (
    <Field label={t("sources.team")} htmlFor={id}>
      <Select id={id} value={teamId} onChange={setTeamId} options={writable.map((tm) => ({ value: tm.id, label: tm.name }))} placeholder={t("sources.audiencePlaceholder")} required />
    </Field>
  );

  const [name, setName] = useState("");
  const [appId, setAppId] = useState("");
  const [installationId, setInstallationId] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const ready = !!name && !!appId && !!privateKey && !!teamId;
  const create = useMutation({
    mutationFn: () => api.createGitSource({ name, teamId, appId: appId.trim(), privateKey, installationId: installationId.trim() || undefined, webhookSecret: webhookSecret || undefined }),
    onSuccess: () => { setName(""); setAppId(""); setInstallationId(""); setPrivateKey(""); setWebhookSecret(""); invalidate(); },
  });

  // Gitea / Forgejo / Codeberg (token). Write-only: cleared right after a successful save.
  const [tKind, setTKind] = useState<"gitea" | "forgejo" | "codeberg">("gitea");
  const [tName, setTName] = useState("");
  const [tUrl, setTUrl] = useState("");
  const [tToken, setTToken] = useState("");
  const tReady = !!tName && !!tToken && !!teamId && (tKind === "codeberg" || !!tUrl);
  const createToken = useMutation({
    mutationFn: () => api.createGitSource({ kind: tKind, name: tName, teamId, apiUrl: tKind === "codeberg" ? undefined : tUrl.trim(), token: tToken }),
    onSuccess: () => { setTName(""); setTUrl(""); setTToken(""); invalidate(); },
  });

  if (!writable.length) return null;
  const grid = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 200px), 1fr))", gap: 12 } as const;
  return (
    <details style={{ marginTop: 8 }}>
      <summary style={{ cursor: "pointer", fontWeight: 600, fontSize: 14, minHeight: 44, display: "flex", alignItems: "center" }}>{t("sources.advanced")}</summary>
      <p style={{ fontSize: 13, color: "var(--c-tx3)", margin: "0 0 12px" }}>{t("sources.advancedHint")}</p>

      <Card style={{ padding: 16 }}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>{t("sources.manualTitle")}</div>
        <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "2px 0 12px" }}>{t("sources.manualHint")}</p>
        <form onSubmit={(e) => { e.preventDefault(); if (ready) create.mutate(); }}>
          <div style={grid}>
            <Field label={t("sources.name")} htmlFor="gs-name"><TextInput id="gs-name" value={name} onChange={(e) => setName(e.target.value)} required /></Field>
            {teamField("gs-team")}
            <Field label={t("sources.manualAppId")} hint={t("sources.manualAppIdHint")} htmlFor="gs-appid"><TextInput id="gs-appid" inputMode="numeric" value={appId} onChange={(e) => setAppId(e.target.value)} required /></Field>
            <Field label={t("sources.installationId")} hint={t("sources.manualInstallationIdHint")} htmlFor="gs-inst"><TextInput id="gs-inst" inputMode="numeric" value={installationId} onChange={(e) => setInstallationId(e.target.value)} /></Field>
            <Field label={t("sources.webhookSecret")} hint={t("sources.manualWebhookSecretHint")} htmlFor="gs-whs"><TextInput id="gs-whs" type="password" autoComplete="new-password" value={webhookSecret} onChange={(e) => setWebhookSecret(e.target.value)} /></Field>
          </div>
          <Field label={t("sources.privateKey")} htmlFor="gs-key" style={{ marginTop: 12 }}>
            <PemDrop id="gs-key" value={privateKey} onChange={setPrivateKey} />
          </Field>
          <div style={{ marginTop: 12 }}><Btn type="submit" loading={create.isPending} disabled={!ready}>{t("sources.manualAdd")}</Btn></div>
          {create.isError && <div role="alert" style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(create.error as Error).message}</div>}
        </form>
      </Card>

      <Card style={{ padding: 16, marginTop: 12 }}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>{t("sources.tokenTitle")}</div>
        <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "2px 0 12px" }}>{t("sources.tokenHint2")}</p>
        <form autoComplete="off" onSubmit={(e) => { e.preventDefault(); if (tReady) createToken.mutate(); }}>
          <div style={grid}>
            <Field label={t("sources.provider")} htmlFor="gt-kind">
              <Select id="gt-kind" value={tKind} onChange={(v) => setTKind(v as "gitea" | "forgejo" | "codeberg")} options={[{ value: "gitea", label: "Gitea" }, { value: "forgejo", label: "Forgejo" }, { value: "codeberg", label: "Codeberg" }]} />
            </Field>
            <Field label={t("sources.name")} htmlFor="gt-name"><TextInput id="gt-name" value={tName} onChange={(e) => setTName(e.target.value)} required /></Field>
            {teamField("gt-team")}
            <Field label={t("sources.baseUrl")} hint={tKind === "codeberg" ? t("sources.codebergUrl") : t("sources.baseUrlHint")} htmlFor="gt-url">
              <TextInput id="gt-url" value={tKind === "codeberg" ? "https://codeberg.org" : tUrl} onChange={(e) => setTUrl(e.target.value)} placeholder="https://git.example.com" disabled={tKind === "codeberg"} required={tKind !== "codeberg"} />
            </Field>
            <Field label={t("sources.token")} hint={t("sources.tokenHint")} htmlFor="gt-token">
              <TextInput id="gt-token" type="password" autoComplete="new-password" value={tToken} onChange={(e) => setTToken(e.target.value)} required />
            </Field>
          </div>
          <div style={{ marginTop: 12 }}><Btn type="submit" loading={createToken.isPending} disabled={!tReady}>{t("sources.connect")}</Btn></div>
          {createToken.isError && <div role="alert" style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(createToken.error as Error).message}</div>}
        </form>
      </Card>
    </details>
  );
}
