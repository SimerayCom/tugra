"use client";

import Link from "next/link";
import type { CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { FolderTree, Plus, Settings } from "lucide-react";
import { api, projectIconUrl, teamIconUrl } from "../../lib/api";
import { projectCards, splitEmptyDefaults, limitRows, teamColor } from "../../lib/dashboard-lists";
import type { Application, Database, Project, Team } from "../../lib/types";
import { useT } from "../../i18n/provider";
import { Badge, Btn, Card, EmptyState } from "../ui";
import { useDashboardInsights } from "./insight-cards";
import { DashCard, SeeAll } from "./dash-card";

const chip: CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, fontWeight: 600,
  color: "var(--c-a)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)",
  padding: "5px 11px", textDecoration: "none",
};
const logoBox: CSSProperties = {
  width: 40, height: 40, borderRadius: 9, background: "var(--c-tile)",
  display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, overflow: "hidden",
};

/** Projects, most recently used first, each tagged with its team (name, colour, icon). Empty default projects
 *  (every team gets one) fold into one summary line instead of repeating "Default" once per team. */
export function ProjectsCard({ projects, teams, apps, databases, teamId }: { projects: Project[]; teams: Team[]; apps: Application[]; databases: Database[]; teamId: string | null }) {
  const t = useT();
  const { data: insights } = useDashboardInsights(teamId);
  // A single-team view needs no team tag; with several teams every project says which one it belongs to.
  const showTeam = teams.length > 1;
  const cards = projectCards(projects, teams, apps, databases, insights?.deploys ?? []);
  const { visible, emptyDefaults } = splitEmptyDefaults(cards);
  const { shown, total } = limitRows(visible);
  const emptyTeams = new Set(emptyDefaults.map((c) => c.project.teamId)).size;
  return (
    <DashCard id="projects" title={t("dashboard.projects")} right={<SeeAll href="/projects" total={total} shown={shown.length} />}>
      {projects.length === 0 ? (
        <Card>
          <EmptyState icon={FolderTree} title={t("dashboard.noProjectsTitle")} action={<Link href="/projects"><Btn>{t("projects.create")}</Btn></Link>}>
            {t("dashboard.noProjects")}
          </EmptyState>
        </Card>
      ) : (
        <>
          {shown.length > 0 && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 300px), 1fr))", gap: 12 }}>
              {shown.map(({ project: p, team, appCount, dbCount }) => {
                const env = p.environments[0]?.id ?? "";
                const color = teamColor(p.teamId, p.color ?? team?.color);
                const icon = projectIconUrl(p.id, p.iconUpdatedAt);
                const tIcon = team ? teamIconUrl(team.id, team.iconUpdatedAt) : null;
                return (
                  <Card key={p.id} style={{ padding: 14, borderLeft: `3px solid ${color}` }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span style={logoBox}>
                        {icon ? <img src={icon} alt="" width={40} height={40} style={{ objectFit: "cover" }} /> : <FolderTree size={20} color="var(--c-a)" aria-hidden />}
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <Link href={`/projects/${p.id}`} style={{ fontWeight: 600, fontSize: 14, color: "var(--c-tx)", textDecoration: "none", overflowWrap: "anywhere" }}>{p.name}</Link>
                        {showTeam && team && (
                          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2, fontSize: 11, color: "var(--c-tx2)", minWidth: 0 }}>
                            {tIcon ? (
                              <img src={tIcon} alt="" width={14} height={14} style={{ borderRadius: 4, objectFit: "cover", flexShrink: 0 }} />
                            ) : (
                              <span aria-hidden style={{ width: 8, height: 8, borderRadius: "50%", background: color, flexShrink: 0 }} />
                            )}
                            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{team.name}</span>
                          </div>
                        )}
                        <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                          <Badge>{t("projects.envCount", { n: p.environments.length })}</Badge>
                          <Badge>{t("projects.appCount", { n: appCount })}</Badge>
                          <Badge>{t("projects.dbCount", { n: dbCount })}</Badge>
                        </div>
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                      <Link href={`/resources/new?project=${p.id}&env=${env}`} style={chip}><Plus size={13} aria-hidden /> {t("dashboard.addResource")}</Link>
                      <Link href={`/projects/${p.id}`} style={chip}><Settings size={13} aria-hidden /> {t("dashboard.settings")}</Link>
                    </div>
                  </Card>
                );
              })}
            </div>
          )}
          {emptyDefaults.length > 0 && (
            <div style={{ marginTop: shown.length > 0 ? 10 : 0, fontSize: 12, color: "var(--c-tx3)" }}>
              <Link href="/projects" style={{ color: "inherit", textDecoration: "none" }}>
                {emptyTeams === 1 ? t("dashboard.emptyDefaultsOne") : t("dashboard.emptyDefaultsMany", { n: emptyTeams })}
              </Link>
            </div>
          )}
        </>
      )}
    </DashCard>
  );
}
