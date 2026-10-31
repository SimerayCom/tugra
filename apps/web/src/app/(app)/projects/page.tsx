"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderTree, Plus, Settings } from "lucide-react";
import { api, projectIconUrl } from "../../../lib/api";
import { clickedInteractive } from "../../../lib/row-nav";
import { useT } from "../../../i18n/provider";
import { Badge, Card, EmptyState, Spinner } from "../../../components/ui";
import { ErrorState } from "../../../components/error-state";
import { TeamBadge, useTeamScope } from "../../../components/team-scope";
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
  const router = useRouter();
  const qc = useQueryClient();
  const { teamId: scope } = useTeamScope();
  const { data: projects = [], isLoading, isError, refetch } = useQuery({ queryKey: ["projects"], queryFn: () => api.listProjects() });
  const { data: teams = [] } = useQuery({ queryKey: ["teams"], queryFn: () => api.listTeams() });

  const [name, setName] = useState("");
  // List follows the global scope (filter); create needs a concrete target team.
  const visible = scopeByTeam(projects, scope);
  const [createTeam, setCreateTeam] = useState("");
  const target = createTeam || defaultTeamId(scope, teams);
  useEffect(() => setCreateTeam(""), [scope]);
  const create = useMutation({
    mutationFn: () => api.createProject(target, name),
    onSuccess: () => {
      setName("");
      setCreateTeam("");
      qc.invalidateQueries({ queryKey: ["projects"] });
    },
  });

  return (
    <div style={{ padding: "var(--page-pad)" }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 4px" }}>{t("projects.title")}</h1>
      <p style={{ color: "var(--c-tx3)", fontSize: 14, margin: "0 0 22px" }}>{t("projects.subtitle")}</p>

      <Card style={{ padding: 16, marginBottom: 20 }}>
        <form
          onSubmit={(e) => { e.preventDefault(); create.mutate(); }}
          style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}
        >
          <input style={{ ...field, flex: 1, minWidth: 160 }} placeholder={t("projects.name")} aria-label={t("projects.name")} value={name} onChange={(e) => setName(e.target.value)} required />
          {teams.length > 1 && (
            <select style={field} value={target} onChange={(e) => setCreateTeam(e.target.value)} aria-label={t("common.team")}>
              {teams.map((tm) => <option key={tm.id} value={tm.id}>{tm.name}</option>)}
            </select>
          )}
          <button type="submit" disabled={create.isPending || !target} style={{ ...field, background: "var(--c-a)", color: "var(--c-on-a)", fontWeight: 600, cursor: "pointer" }}>
            {create.isPending ? "…" : t("projects.create")}
          </button>
        </form>
        {create.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(create.error as Error).message}</div>}
      </Card>

      {isError && projects.length === 0 ? (
        <ErrorState onRetry={() => refetch()} />
      ) : isLoading ? (
        <Spinner />
      ) : (
        <div style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r2)", overflow: "hidden" }}>
          {visible.map((p) => {
            const apps = p.environments.reduce((n, e) => n + e.appCount, 0);
            const dbs = p.environments.reduce((n, e) => n + e.dbCount, 0);
            return (
              <div
                key={p.id}
                className="row-link"
                onClick={(e) => { if (!clickedInteractive(e)) router.push(`/projects/${p.id}`); }}
                style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderTop: "1px solid var(--c-bd)", color: "var(--c-tx)" }}
              >
                <span style={{ width: 36, height: 36, borderRadius: 8, background: "var(--c-tile)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, overflow: "hidden" }}>
                  {projectIconUrl(p.id, p.iconUpdatedAt) ? (
                    <img src={projectIconUrl(p.id, p.iconUpdatedAt)!} alt="" width={36} height={36} style={{ objectFit: "cover" }} />
                  ) : (
                    <FolderTree size={18} color="var(--c-a)" />
                  )}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Link href={`/projects/${p.id}`} style={{ fontWeight: 600, fontSize: 14, color: "var(--c-tx)", textDecoration: "none" }}>{p.name}</Link>
                  <div style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
                    <Badge>{p.environments.length} env</Badge>
                    <Badge>{apps} apps</Badge>
                    <Badge>{dbs} dbs</Badge>
                    {scope === null && teams.length > 1 && <TeamBadge teamId={p.teamId} teams={teams} />}
                  </div>
                </div>
                <Link href={`/resources/new?project=${p.id}&env=${p.environments[0]?.id ?? ""}`} style={rowChip}><Plus size={13} /> {t("dashboard.addResource")}</Link>
                <Link href={`/projects/${p.id}`} style={rowChip}><Settings size={13} /> {t("dashboard.settings")}</Link>
              </div>
            );
          })}
          {visible.length === 0 && (
            <EmptyState icon={FolderTree} title={t("projects.emptyTitle")}>{t("projects.empty")}</EmptyState>
          )}
        </div>
      )}
    </div>
  );
}
