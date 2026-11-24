"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { GitBranch } from "lucide-react";
import { api } from "../../../lib/api";
import { useT } from "../../../i18n/provider";
import { useToast } from "../../../components/toast";
import { Card, EmptyState, Spinner } from "../../../components/ui";
import { ErrorState } from "../../../components/error-state";
import { useConfirm } from "../../../components/confirm";
import { useAuth } from "../../../lib/auth";
import { ConnectGithub } from "../../../components/sources/connect-github";
import { GitSourceCard } from "../../../components/sources/git-source-card";
import { ManualSources } from "../../../components/sources/manual-sources";

export default function SourcesPage() {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { user } = useAuth();
  const isOwner = user?.isInstanceOwner === true;
  const { data: teams = [] } = useQuery({ queryKey: ["teams"], queryFn: () => api.listTeams() });
  const { data: sources = [], isLoading, isError, refetch } = useQuery({ queryKey: ["gitSources"], queryFn: () => api.listGitSources() });

  const del = useMutation({
    mutationFn: (id: string) => api.deleteGitSource(id),
    onSuccess: (_r, id) => { qc.invalidateQueries({ queryKey: ["gitSources"] }); toast(t("common.deletedNamed", { name: sources.find((s) => s.id === id)?.name ?? "" }), "success"); },
  });
  const teamName = (id: string) => teams.find((tm) => tm.id === id)?.name ?? "";

  return (
    <div style={{ padding: "var(--page-pad)", maxWidth: 960 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 4px", display: "flex", alignItems: "center", gap: 8 }}>
        <GitBranch size={20} color="var(--c-a)" aria-hidden /> {t("sources.title")}
      </h1>
      <p style={{ color: "var(--c-tx3)", fontSize: 14, margin: "0 0 20px" }}>{t("sources.subtitle")}</p>

      <ConnectGithub teams={teams} isOwner={isOwner} />

      {isError && sources.length === 0 ? (
        <ErrorState onRetry={() => refetch()} />
      ) : isLoading ? (
        <Spinner />
      ) : sources.length === 0 ? (
        <Card style={{ marginBottom: 20 }}><EmptyState icon={GitBranch} title={t("sources.emptyTitle")}>{t("sources.noSources")}</EmptyState></Card>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 320px), 1fr))", gap: 12, marginBottom: 24, alignItems: "start" }}>
          {sources.map((s) => (
            <GitSourceCard
              key={s.id}
              source={s}
              teamName={teamName(s.teamId)}
              isOwner={isOwner}
              onDelete={async () => { if (await confirm({ body: t("common.deleteNamedConfirm", { name: s.name }), danger: true })) del.mutate(s.id); }}
            />
          ))}
        </div>
      )}

      <ManualSources teams={teams} />
    </div>
  );
}
