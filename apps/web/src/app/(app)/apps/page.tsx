"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Box, SearchX } from "lucide-react";
import { api, appIconUrl } from "../../../lib/api";
import { appColor, appSourceSummary } from "../../../lib/apps";
import { useT } from "../../../i18n/provider";
import { Btn, EmptyState, LinkBtn, StatusPill } from "../../../components/ui";
import { ListCard, ListRow } from "../../../components/list";
import { PageTitle } from "../../../components/page-header";
import { SkeletonTable } from "../../../components/skeleton";
import { statusLabel } from "../../../lib/status";
import { AppLogo } from "../../../components/app-logo";
import { TextInput } from "../../../components/form";
import { ErrorState } from "../../../components/error-state";
import { TagChips, TagFilter } from "../../../components/tags";
import { scopeByTeam } from "../../../lib/team-scope";
import { useTeamScope } from "../../../components/team-scope";

export default function AppsPage() {
  const t = useT();
  const { teamId } = useTeamScope();
  const { data: apps = [], isLoading, isError, refetch } = useQuery({
    queryKey: ["apps"],
    queryFn: () => api.listApps(),
    refetchInterval: 8000,
  });

  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const scoped = scopeByTeam(apps, teamId);
  const allTags = [...new Set(scoped.flatMap((a) => a.tags))].sort();
  const ql = q.trim().toLowerCase();
  const visibleApps = scoped.filter(
    (a) => selectedTags.every((tag) => a.tags.includes(tag)) && (ql === "" || a.name.toLowerCase().includes(ql)),
  );

  return (
    <div style={{ padding: "var(--page-pad)" }}>
      <PageTitle
        title={t("apps.title")}
        subtitle={t("apps.subtitle")}
        actions={<LinkBtn href="/resources/new?kind=app">{t("apps.newApp")}</LinkBtn>}
      />

      {isError && apps.length === 0 ? (
        <ErrorState onRetry={() => refetch()} />
      ) : isLoading ? (
        <SkeletonTable detailed />
      ) : (
        <>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
            <TextInput value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("apps.searchApps")} aria-label={t("apps.searchApps")} style={{ maxWidth: 260 }} />
            <TagFilter all={allTags} selected={selectedTags} onChange={setSelectedTags} />
          </div>
          <ListCard>
            {visibleApps.map((a, i) => (
              <ListRow key={a.id} index={i} href={`/apps/${a.id}`}>
                <span style={{ width: 36, height: 36, borderRadius: 8, background: "var(--c-tile)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <AppLogo iconUrl={appIconUrl(a.id, a.iconUpdatedAt)} templateSlug={a.templateSlug} templateLogo={a.templateLogo} source={a.source} name={a.name} size={18} />
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 14, display: "flex", alignItems: "center", gap: 8 }}>
                    {a.name}
                    <TagChips tags={a.tags} />
                  </div>
                  <div className="mono" style={{ fontSize: 11, color: "var(--c-tx3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{appSourceSummary(a)}</div>
                </div>
                {a.projectName && (
                  <span style={{ fontSize: 12, color: "var(--c-tx3)", whiteSpace: "nowrap", flexShrink: 0 }}>
                    {a.projectName} / {a.environmentName}
                  </span>
                )}
                <StatusPill label={statusLabel(t, a.status)} color={appColor(a.status)} />
              </ListRow>
            ))}
            {visibleApps.length === 0 &&
              (apps.length === 0 ? (
                <EmptyState
                  icon={Box}
                  title={t("apps.emptyTitle")}
                  action={<LinkBtn href="/resources/new?kind=app">{t("apps.newApp")}</LinkBtn>}
                >
                  {t("apps.empty")}
                </EmptyState>
              ) : scoped.length === 0 ? (
                <EmptyState icon={SearchX} title={t("common.noResults")}>
                  {t("common.noneInScope")}
                </EmptyState>
              ) : (
                <EmptyState
                  icon={SearchX}
                  title={t("common.noResults")}
                  action={<Btn variant="ghost" onClick={() => { setQ(""); setSelectedTags([]); }}>{t("common.clearFilters")}</Btn>}
                >
                  {t("common.noResultsHint")}
                </EmptyState>
              ))}
          </ListCard>
        </>
      )}
    </div>
  );
}
