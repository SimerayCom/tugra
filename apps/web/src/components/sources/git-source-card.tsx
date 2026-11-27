"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronUp, Copy, Lock, Plus, Trash2, Globe, X } from "lucide-react";
import { api } from "../../lib/api";
import type { GitSource } from "../../lib/types";
import { useT } from "../../i18n/provider";
import { useToast } from "../toast";
import { sourceKindLabel } from "../../lib/source-kind";
import { filterRepos, isGithubInstallUrl, isPubliclyReachable } from "../../lib/github-manifest";
import { Badge, Btn, Card } from "../ui";
import { IconBtn } from "../icon-btn";
import { TextInput } from "../form";
import { AccountAvatar, ProviderIcon } from "./provider-icon";

/** One connected Git host: provider icon, who it is installed for, status, repository count and a searchable
 *  repository list. Actions (install, add account, share, delete) only appear for people who may use them. */
export function GitSourceCard({ source, teamName, isOwner, onDelete, deleting }: { source: GitSource; teamName: string; isOwner: boolean; onDelete: () => void; deleting?: boolean }) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const { id, name, kind, canWrite, apiUrl, installationId, sharedAllTeams } = source;
  const installs = source.installations ?? [];
  const isGithub = kind === "github";
  const installed = !isGithub || installs.length > 0 || !!installationId;

  const [open, setOpen] = useState(false);
  // The card only needs a number: ask for the full list when it is expanded, never on page load.
  const countQ = useQuery({ queryKey: ["gitSourceRepoCount", id], queryFn: () => api.getSourceRepoCount(id), enabled: installed, staleTime: 60_000, retry: false });
  const repos = useQuery({ queryKey: ["gitSourceRepos", id], queryFn: () => api.listSourceRepos(id), enabled: installed && open, staleTime: 60_000, retry: false });
  const [q, setQ] = useState("");
  const [copied, setCopied] = useState(false);

  const share = useMutation({
    mutationFn: (next: boolean) => api.setGitSourceSharing(id, next),
    onSuccess: (s) => { qc.invalidateQueries({ queryKey: ["gitSources"] }); toast(t(s.sharedAllTeams ? "sources.sharedOn" : "sources.sharedOff"), "success"); },
    onError: (e) => toast((e as Error).message, "error"),
  });
  const removeInstall = useMutation({
    mutationFn: (installationId: string) => api.removeGitSourceInstallation(id, installationId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["gitSources"] });
      qc.invalidateQueries({ queryKey: ["gitSourceRepoCount", id] });
      qc.invalidateQueries({ queryKey: ["gitSourceRepos", id] });
      toast(t("sources.accountRemoved"), "success");
    },
    onError: (e) => toast((e as Error).message, "error"),
  });
  const install = useMutation({
    mutationFn: () => api.startGithubInstall(id),
    onSuccess: (r) => { if (isGithubInstallUrl(r.installUrl)) window.location.assign(r.installUrl); },
    onError: (e) => toast((e as Error).message, "error"),
  });

  const count = countQ.data?.count;
  const capped = count !== undefined && repos.data !== undefined && repos.data.length < count;
  const shown = filterRepos(repos.data ?? [], q);
  const detail = isGithub ? null : apiUrl;
  const copyWebhook = async () => {
    if (!source.webhookUrl) return;
    try { await navigator.clipboard.writeText(source.webhookUrl); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard unavailable */ }
  };

  return (
    <Card style={{ padding: 14, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <ProviderIcon kind={kind} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 14, overflowWrap: "anywhere" }}>{name}</div>
          <div style={{ fontSize: 12, color: "var(--c-tx3)" }}>{sourceKindLabel(kind, t)}{detail ? ` · ${detail}` : ""}</div>
        </div>
        {canWrite && <IconBtn label={t("sources.delete")} danger loading={deleting} onClick={onDelete}><Trash2 size={15} /></IconBtn>}
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
        {installed ? <Badge tone="ok">{t("sources.connected")}</Badge> : <Badge tone="warn">{t("sources.needsInstall")}</Badge>}
        <Badge tone="muted">{sharedAllTeams ? t("sources.allTeams") : teamName}</Badge>
        {installed && (
          <span aria-live="polite" style={{ fontSize: 12, color: countQ.isError ? "var(--c-r)" : "var(--c-tx3)" }}>
            {countQ.isLoading ? t("sources.repoCountLoading") : countQ.isError ? t("sources.repoCountError") : count === 1 ? t("sources.repoCountOne") : t("sources.repoCountMany", { count: count ?? 0 })}
          </span>
        )}
      </div>

      {isGithub && installs.length > 0 && (
        <ul aria-label={t("sources.installedOn")} style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexWrap: "wrap", gap: 8 }}>
          {installs.map((i) => (
            <li key={i.installationId} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 10px 3px 4px", borderRadius: 999, background: "var(--c-el)", border: "1px solid var(--c-bd)", fontSize: 12 }}>
              <AccountAvatar login={i.accountLogin} url={i.avatarUrl} />
              <span>{i.accountLogin ?? i.installationId}</span>
              {canWrite && (
                <IconBtn label={t("sources.removeAccount", { name: i.accountLogin ?? i.installationId })} onClick={() => removeInstall.mutate(i.installationId)} disabled={removeInstall.isPending}><X size={13} /></IconBtn>
              )}
            </li>
          ))}
        </ul>
      )}

      {isGithub && source.webhookUrl && !isPubliclyReachable(source.webhookUrl) && (
        <div role="status" style={{ fontSize: 12, color: "var(--c-am)" }}>{t("sources.webhookOff")}</div>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {installed && (
          <Btn variant="ghost" aria-expanded={open} onClick={() => setOpen((o) => !o)} icon={open ? ChevronUp : ChevronDown}>
            {open ? t("sources.hideRepos") : t("sources.showRepos")}
          </Btn>
        )}
        {isGithub && canWrite && (
          <Btn variant="ghost" icon={Plus} loading={install.isPending} onClick={() => install.mutate()} title={installed ? t("sources.addAccountHint") : undefined}>
            {installed ? t("sources.addAccount") : t("sources.install")}
          </Btn>
        )}
        {canWrite && isOwner && (
          <Btn variant="ghost" aria-pressed={sharedAllTeams} title={t("sources.shareHint")} loading={share.isPending} onClick={() => share.mutate(!sharedAllTeams)}>
            {sharedAllTeams ? t("sources.unshare") : t("sources.share")}
          </Btn>
        )}
      </div>

      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {repos.isLoading && <div role="status" style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("sources.repoCountLoading")}</div>}
          {repos.isError && <div role="alert" style={{ fontSize: 12, color: "var(--c-r)" }}>{t("sources.repoCountError")}</div>}
          {capped && <div style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("sources.repoListCapped", { shown: repos.data?.length ?? 0, count: count ?? 0 })}</div>}
          <TextInput type="search" value={q} onChange={(e) => setQ(e.target.value)} aria-label={t("sources.searchRepos")} placeholder={t("sources.searchRepos")} autoComplete="off" />
          {repos.data && repos.data.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("sources.noRepos")}</div>
          ) : shown.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("sources.noRepoMatch")}</div>
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: 0, maxHeight: 240, overflowY: "auto", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)" }}>
              {shown.map((r) => (
                <li key={r.fullName} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderBottom: "1px solid var(--c-bd)", fontSize: 13 }}>
                  <span className="mono" style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>{r.fullName}</span>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--c-tx3)" }}>
                    {r.private ? <Lock size={12} aria-hidden /> : <Globe size={12} aria-hidden />}
                    {r.private ? t("sources.private") : t("sources.public")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {isGithub && source.webhookUrl && canWrite && (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="mono" style={{ flex: 1, minWidth: 0, fontSize: 11, color: "var(--c-tx3)", overflowWrap: "anywhere" }} title={t("sources.webhookUrl")}>{source.webhookUrl}</span>
          <IconBtn label={copied ? t("sources.copied") : t("sources.copy")} onClick={copyWebhook}>{copied ? <Check size={15} /> : <Copy size={15} />}</IconBtn>
        </div>
      )}
    </Card>
  );
}
