"use client";

import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useT } from "../../i18n/provider";
import { Btn, Card } from "../ui";
import { Checkbox, Field, Select, TextInput } from "../form";
import type { GithubManifestStart } from "../../lib/types";
import { isGithubLogin, postManifestToGithub } from "../../lib/github-manifest";
import { ProviderIcon } from "./provider-icon";

const ALL = "__all__";

/** "Connect GitHub": pick who can use it and which account, then one click. Tugra opens GitHub with the App
 *  pre-filled (name, permissions, webhook, redirect); the user clicks Create there and Install after. */
export function ConnectGithub({ teams, isOwner }: { teams: { id: string; name: string; role: string }[]; isOwner: boolean }) {
  const t = useT();
  const writable = useMemo(() => teams.filter((tm) => tm.role !== "VIEWER"), [teams]);
  const options = useMemo(
    () => [...writable.map((tm) => ({ value: tm.id, label: t("sources.audienceTeam", { name: tm.name }) })), ...(isOwner ? [{ value: ALL, label: t("sources.audienceAll") }] : [])],
    [writable, isOwner, t],
  );
  // A visible choice, never a silent default: with several options nothing is picked until the user picks.
  const [picked, setPicked] = useState("");
  const audience = picked || (options.length === 1 ? options[0].value : "");
  const [org, setOrg] = useState(false);
  const [orgName, setOrgName] = useState("");
  const [appName, setAppName] = useState("");
  const [anyAccount, setAnyAccount] = useState(false);

  const orgOk = !org || isGithubLogin(orgName.trim());
  const ready = !!audience && orgOk && (!org || !!orgName.trim());
  const teamId = audience === ALL ? writable[0]?.id ?? "" : audience;

  // A hub GitHub cannot reach would silently never get push events: say so before the App is created there.
  const [held, setHeld] = useState<GithubManifestStart | null>(null);
  const start = useMutation({
    mutationFn: () =>
      api.startGithubManifest({
        teamId,
        name: appName.trim() || undefined,
        org: org ? orgName.trim() : undefined,
        anyAccount: anyAccount || undefined,
        sharedAllTeams: audience === ALL || undefined,
      }),
    onSuccess: (r) => {
      if (r.webhookActive) postManifestToGithub(r.postUrl, r.manifest);
      else setHeld(r);
    },
  });

  if (!writable.length) return null;
  return (
    <Card style={{ padding: 16, marginBottom: 20 }}>
      <form
        onSubmit={(e) => { e.preventDefault(); if (ready && !start.isPending) start.mutate(); }}
        style={{ display: "flex", flexDirection: "column", gap: 14 }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <ProviderIcon kind="github" size={40} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 15 }}>{t("sources.connectGithub")}</div>
            <div style={{ fontSize: 13, color: "var(--c-tx3)" }}>{t("sources.connectGithubHint")}</div>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))", gap: 12 }}>
          <Field label={t("sources.audience")} htmlFor="gh-audience" hint={t("sources.audienceHint")}>
            <Select id="gh-audience" value={audience} onChange={setPicked} options={options} placeholder={t("sources.audiencePlaceholder")} required />
          </Field>
          <Field label={t("sources.account")} htmlFor="gh-account">
            <Select
              id="gh-account"
              value={org ? "org" : "me"}
              onChange={(v) => setOrg(v === "org")}
              options={[{ value: "me", label: t("sources.accountPersonal") }, { value: "org", label: t("sources.accountOrg") }]}
            />
          </Field>
          {org && (
            <Field label={t("sources.orgName")} htmlFor="gh-org" hint={t("sources.orgNameHint")} error={orgName && !orgOk ? t("sources.orgInvalid") : undefined}>
              <TextInput id="gh-org" value={orgName} onChange={(e) => setOrgName(e.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} required />
            </Field>
          )}
        </div>

        <details>
          <summary style={{ cursor: "pointer", fontSize: 13, color: "var(--c-tx2)", minHeight: 32, display: "flex", alignItems: "center" }}>{t("sources.more")}</summary>
          <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 10 }}>
            <Field label={t("sources.appName")} htmlFor="gh-appname" hint={t("sources.appNameHint")}>
              <TextInput id="gh-appname" value={appName} onChange={(e) => setAppName(e.target.value)} maxLength={34} autoComplete="off" placeholder={t("sources.appNamePlaceholder")} />
            </Field>
            <div>
              <Checkbox checked={anyAccount} onChange={setAnyAccount} label={t("sources.anyAccount")} />
              <div style={{ fontSize: 11, color: "var(--c-tx3)", margin: "4px 0 0 24px" }}>{t("sources.anyAccountHint")}</div>
            </div>
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--c-tx2)", marginBottom: 6 }}>{t("sources.autoFilled")}</div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: "var(--c-tx3)", display: "flex", flexDirection: "column", gap: 4 }}>
                <li>{t("sources.autoRedirect")}</li>
                <li>{t("sources.autoSetup")}</li>
                <li>{t("sources.autoWebhook")}</li>
              </ul>
            </div>
          </div>
        </details>

        <div>
          <Btn type="submit" loading={start.isPending} disabled={!ready}>{start.isPending ? t("sources.connecting") : t("sources.connectGithub")}</Btn>
        </div>
        {held && (
          <div role="alert" style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start", fontSize: 12, color: "var(--c-am)" }}>
            <span>{t("sources.webhookOffBefore")}</span>
            <Btn variant="ghost" onClick={() => { postManifestToGithub(held.postUrl, held.manifest); setHeld(null); }}>{t("sources.continueAnyway")}</Btn>
          </div>
        )}
        {start.isError && <div role="alert" style={{ color: "var(--c-r)", fontSize: 12 }}>{(start.error as Error).message}</div>}
      </form>
    </Card>
  );
}
