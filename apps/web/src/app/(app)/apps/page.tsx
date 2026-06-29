"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Box, GitBranch, Layers } from "lucide-react";
import { api } from "../../../lib/api";
import { appColor, appSourceSummary } from "../../../lib/apps";
import { useT } from "../../../i18n/provider";
import { Btn, EmptyState, Spinner, StatusPill } from "../../../components/ui";
import { TagChips, TagFilter } from "../../../components/tags";
import { scopeByTeam } from "../../../lib/team-scope";
import { useTeamScope } from "../../../components/team-scope";

const SOURCE_ICON = { IMAGE: Box, GIT: GitBranch, COMPOSE: Layers } as const;

export default function AppsPage() {
  const t = useT();
  const { teamId } = useTeamScope();
  const { data: apps = [], isLoading } = useQuery({
    queryKey: ["apps"],
    queryFn: () => api.listApps(),
    refetchInterval: 8000,
  });

  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const scoped = scopeByTeam(apps, teamId);
  const allTags = [...new Set(scoped.flatMap((a) => a.tags))].sort();
  const visibleApps = scoped.filter((a) => selectedTags.every((tag) => a.tags.includes(tag)));

  return (
    <div style={{ padding: "var(--page-pad)" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 22 }}>
        <div style={{ flex: 1 }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 4px" }}>{t("apps.title")}</h1>
          <p style={{ color: "var(--c-tx3)", fontSize: 14, margin: 0 }}>{t("apps.subtitle")}</p>
        </div>
        <Link href="/resources/new?kind=app" style={{ background: "var(--c-a)", color: "#0d0d11", fontWeight: 600, fontSize: 13, padding: "9px 14px", borderRadius: "var(--r1)", textDecoration: "none" }}>
          {t("apps.newApp")}
        </Link>
      </div>

      {isLoading ? (
        <Spinner />
      ) : (
        <>
          <TagFilter all={allTags} selected={selectedTags} onChange={setSelectedTags} />
          <div style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r2)", overflow: "hidden" }}>
            {visibleApps.map((a) => {
              const Icon = SOURCE_ICON[a.source] ?? Box;
              return (
                <Link key={a.id} href={`/apps/${a.id}`} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderTop: "1px solid var(--c-bd)", textDecoration: "none", color: "var(--c-tx)" }}>
                  <span style={{ width: 36, height: 36, borderRadius: 8, background: "rgba(255,255,255,0.06)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <Icon size={18} color="var(--c-a)" />
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 14, display: "flex", alignItems: "center", gap: 8 }}>
                      {a.name}
                      <TagChips tags={a.tags} />
                    </div>
                    <div className="mono" style={{ fontSize: 11, color: "var(--c-tx3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{appSourceSummary(a)}</div>
                  </div>
                  <StatusPill label={a.status} color={appColor(a.status)} />
                </Link>
              );
            })}
            {visibleApps.length === 0 && (
              <EmptyState
                icon={Box}
                title={t("apps.emptyTitle")}
                action={<Link href="/resources/new?kind=app"><Btn>{t("apps.newApp")}</Btn></Link>}
              >
                {t("apps.empty")}
              </EmptyState>
            )}
          </div>
        </>
      )}
    </div>
  );
}
