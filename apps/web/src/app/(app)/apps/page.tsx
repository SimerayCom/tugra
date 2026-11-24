"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Box, SearchX } from "lucide-react";
import Link from "next/link";
import { useGuardedPush } from "../../../hooks/useUnsavedChanges";
import { api, appIconUrl } from "../../../lib/api";
import { appStatusDisplay, appSourceSummary } from "../../../lib/apps";
import { ImageUpdateBadge } from "./[id]/image-update-card";
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
import { SortBar } from "../../../components/sort-bar";
import { sortApps, toggleSort, defaultAppSortDir, type AppSortKey, type SortState } from "../../../lib/list-sort";
import { scopeByTeam } from "../../../lib/team-scope";
import { useTeamScope } from "../../../components/team-scope";
import { ProjectDot } from "../../../components/project-dot";

export default function AppsPage() {
  const t = useT();
  const push = useGuardedPush();
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
  const [sort, setSort] = useState<SortState<AppSortKey>>(null);
  const filtered = scoped.filter(
    (a) => selectedTags.every((tag) => a.tags.includes(tag)) && (ql === "" || a.name.toLowerCase().includes(ql)),
  );
  const visibleApps = sort ? sortApps(filtered, sort.key, sort.dir) : filtered;
  const toggleTag = (tag: string) => setSelectedTags((cur) => (cur.includes(tag) ? cur.filter((x) => x !== tag) : [...cur, tag]));

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
            <SortBar
              options={[
                { key: "name", label: t("apps.sortName") },
                { key: "status", label: t("apps.sortStatus") },
                { key: "project", label: t("apps.sortProject") },
              ]}
              sort={sort}
              onSort={(key) => setSort((prev) => toggleSort(prev, key, defaultAppSortDir(key)))}
            />
          </div>
          <TagFilter all={allTags} selected={selectedTags} onChange={setSelectedTags} />
          <ListCard>
            {visibleApps.map((a, i) => (
              // Whole row navigates on click; the name link is the keyboard path, so the tag chips (real buttons) can live inside.
              <ListRow key={a.id} index={i} onClick={() => push(`/apps/${a.id}`)} tabbable={false}>
                <span style={{ width: 36, height: 36, borderRadius: 8, background: "var(--c-tile)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <AppLogo iconUrl={appIconUrl(a.id, a.iconUpdatedAt)} templateSlug={a.templateSlug} templateLogo={a.templateLogo} source={a.source} name={a.name} size={18} />
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 14, display: "flex", alignItems: "center", gap: 8 }}>
                    <Link href={`/apps/${a.id}`} style={{ color: "var(--c-tx)", textDecoration: "none" }}>{a.name}</Link>
                    <TagChips tags={a.tags} onSelect={toggleTag} selected={selectedTags} />
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                    <div className="mono" style={{ fontSize: 11, color: "var(--c-tx3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{appSourceSummary(a)}</div>
                    <ImageUpdateBadge app={a} />
                  </div>
                </div>
                {a.projectName && (
                  <span style={{ fontSize: 12, color: "var(--c-tx3)", whiteSpace: "nowrap", flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 5 }}>
                  <ProjectDot projectId={a.projectId} />
                    {a.projectName} / {a.environmentName}
                  </span>
                )}
                <StatusPill label={statusLabel(t, appStatusDisplay(a).key)} color={appStatusDisplay(a).color} />
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
