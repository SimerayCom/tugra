"use client";

import Link from "next/link";
import { useGuardedPush } from "../../../hooks/useUnsavedChanges";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderTree, Plus, SearchX, Settings } from "lucide-react";
import { api, projectIconUrl } from "../../../lib/api";
import { useT } from "../../../i18n/provider";
import { Badge, Btn, Card, EmptyState } from "../../../components/ui";
import { ListCard, ListRow } from "../../../components/list";
import { PageTitle } from "../../../components/page-header";
import { SkeletonTable } from "../../../components/skeleton";
import { ErrorState } from "../../../components/error-state";
import { EntityTile } from "../../../components/entity-identity";
import { TeamBadge, useTeamContext, useTeamScope } from "../../../components/team-scope";
import { TeamPicker } from "../../../components/team-picker";
import { TeamGroups } from "../../../components/team-groups";
import { EmptyDefaultsCard } from "../../../components/empty-defaults-card";
import { SortBar } from "../../../components/sort-bar";
import { sortProjects, toggleSort, defaultProjectSortDir, type ProjectSortKey, type SortState } from "../../../lib/list-sort";
import { scopeByTeam, defaultTeamId } from "../../../lib/team-scope";

const field: React.CSSProperties = {
  padding: "8px 10px",
  background: "var(--c-el)",
  border: "1px solid var(--c-bd)",
  borderRadius: "var(--r1)",
  color: "var(--c-tx)",
  fontSize: 13,
  fontFamily: "inherit",
};

const rowChip: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  fontSize: 12,
  fontWeight: 600,
  color: "var(--c-a)",
  border: "1px solid var(--c-bd)",
  borderRadius: "var(--r1)",
  padding: "5px 10px",
  textDecoration: "none",
  flexShrink: 0,
};

export default function ProjectsPage() {
  const t = useT();
  const push = useGuardedPush();
  const qc = useQueryClient();
  const { teamId: scope } = useTeamScope();
  const { data: projects = [], isLoading, isError, refetch } = useQuery({ queryKey: ["projects"], queryFn: () => api.listProjects() });
  const { data: teams = [] } = useQuery({ queryKey: ["teams"], queryFn: () => api.listTeams() });
  const { show: showTeam } = useTeamContext();

  const [name, setName] = useState("");
  // List follows the global scope (filter); create needs a concrete target team.
  const scoped = scopeByTeam(projects, scope);
  const [sort, setSort] = useState<SortState<ProjectSortKey>>(null);
  const visible = sort ? sortProjects(scoped, sort.key, sort.dir) : scoped;
  const [createTeam, setCreateTeam] = useState("");
  const target = createTeam || defaultTeamId(scope, teams);
  useEffect(() => setCreateTeam(""), [scope]);
  const create = useMutation({
    mutationFn: (projectName: string) => api.createProject(target, projectName),
    onSuccess: () => {
      setName("");
      setCreateTeam("");
      qc.invalidateQueries({ queryKey: ["projects"] });
    },
  });
  // Quick path for a team with no project yet: the project is named after the team, never "Default".
  const targetTeamName = teams.find((tm) => tm.id === target)?.name ?? "";

  return (
    <div style={{ padding: "var(--page-pad)" }}>
      <PageTitle title={t("projects.title")} subtitle={t("projects.subtitle")} />

      <EmptyDefaultsCard />

      <Card style={{ padding: 16, marginBottom: 20 }}>
        <form
          onSubmit={(e) => { e.preventDefault(); create.mutate(name); }}
          style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}
        >
          <input style={{ ...field, minHeight: 44, flex: 1, minWidth: 160 }} placeholder={t("projects.name")} aria-label={t("projects.name")} value={name} onChange={(e) => setName(e.target.value)} required />
          {teams.length > 1 && (
            <div style={{ flex: "0 1 200px", minWidth: 140 }}>
              <TeamPicker value={target} teams={teams} onChange={setCreateTeam} ariaLabel={t("common.team")} />
            </div>
          )}
          <button type="submit" disabled={create.isPending || !target} style={{ ...field, minHeight: 44, background: "var(--c-a)", color: "var(--c-on-a)", fontWeight: 600, cursor: "pointer" }}>
            {create.isPending ? "…" : t("projects.create")}
          </button>
        </form>
        {create.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(create.error as Error).message}</div>}
      </Card>

      {isError && projects.length === 0 ? (
        <ErrorState onRetry={() => refetch()} />
      ) : isLoading ? (
        <SkeletonTable detailed />
      ) : (
        <>
        {projects.length > 1 && (
          <div style={{ marginBottom: 12 }}>
            <SortBar
              options={[
                { key: "name", label: t("projects.sortName") },
                { key: "resources", label: t("projects.sortResources") },
                { key: "created", label: t("projects.sortCreated") },
              ]}
              sort={sort}
              onSort={(key) => setSort((prev) => toggleSort(prev, key, defaultProjectSortDir(key)))}
            />
          </div>
        )}
        {visible.length > 0 ? (
          <TeamGroups
            items={visible}
            teams={teams}
            grouped={showTeam}
            render={(rows) => (
              <ListCard>
                {rows.map((p, i) => {
                  const apps = p.environments.reduce((n, e) => n + e.appCount, 0);
                  const dbs = p.environments.reduce((n, e) => n + e.dbCount, 0);
                  return (
                    // Whole row navigates on click; the name link below is the keyboard path, so no extra tab stop.
                    <ListRow key={p.id} index={i} onClick={() => push(`/projects/${p.id}`)} tabbable={false}>
                      <EntityTile color={p.color} size={36} iconUrl={projectIconUrl(p.id, p.iconUpdatedAt)} fallback={<FolderTree size={18} color="currentColor" aria-hidden />} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <Link href={`/projects/${p.id}`} style={{ fontWeight: 600, fontSize: 14, color: "var(--c-tx)", textDecoration: "none" }}>{p.name}</Link>
                        <div style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
                          <Badge>{t("projects.envCount", { n: p.environments.length })}</Badge>
                          <Badge>{t("projects.appCount", { n: apps })}</Badge>
                          <Badge>{t("projects.dbCount", { n: dbs })}</Badge>
                          {showTeam && <TeamBadge teamId={p.teamId} teams={teams} />}
                        </div>
                      </div>
                      <Link href={`/resources/new?project=${p.id}&env=${p.environments[0]?.id ?? ""}`} style={rowChip}><Plus size={13} /> {t("dashboard.addResource")}</Link>
                      <Link href={`/projects/${p.id}`} style={rowChip}><Settings size={13} /> {t("dashboard.settings")}</Link>
                    </ListRow>
                  );
                })}
              </ListCard>
            )}
          />
        ) : (
          <ListCard>
            {projects.length === 0 ? (
              // First run (a new team has no project): one clear next step, or bring existing work over.
              <EmptyState
                icon={FolderTree}
                title={t("projects.firstTitle")}
                action={
                  <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
                    {target && targetTeamName && (
                      <Btn onClick={() => create.mutate(targetTeamName)} loading={create.isPending} style={{ minHeight: 44 }}>
                        {t("projects.firstQuick", { name: targetTeamName })}
                      </Btn>
                    )}
                    <Link href="/import" style={{ ...rowChip, minHeight: 44, padding: "0 14px", fontSize: 13 }}>{t("projects.firstImport")}</Link>
                  </div>
                }
              >
                {t("projects.first")}
              </EmptyState>
            ) : (
              // Projects exist, but the global team scope hides them all — not a first-run state.
              <EmptyState icon={SearchX} title={t("common.noResults")}>{t("projects.noneInScope")}</EmptyState>
            )}
          </ListCard>
        )}
        </>
      )}
    </div>
  );
}
