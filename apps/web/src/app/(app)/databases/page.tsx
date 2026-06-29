"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Database } from "lucide-react";
import { api } from "../../../lib/api";
import { dbColor, engineLabel } from "../../../lib/databases";
import { useT } from "../../../i18n/provider";
import { Btn, EmptyState, Spinner } from "../../../components/ui";
import { TagChips, TagFilter } from "../../../components/tags";
import { scopeByTeam } from "../../../lib/team-scope";
import { useTeamScope } from "../../../components/team-scope";

export default function DatabasesPage() {
  const t = useT();
  const { teamId } = useTeamScope();
  const { data: databases = [], isLoading } = useQuery({
    queryKey: ["databases"],
    queryFn: () => api.listDatabases(),
    refetchInterval: 8000,
  });

  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const scoped = scopeByTeam(databases, teamId);
  const allTags = [...new Set(scoped.flatMap((d) => d.tags))].sort();
  const visible = scoped.filter((d) => selectedTags.every((tag) => d.tags.includes(tag)));

  return (
    <div style={{ padding: "var(--page-pad)" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 22 }}>
        <div style={{ flex: 1 }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 4px" }}>{t("databases.title")}</h1>
          <p style={{ color: "var(--c-tx3)", fontSize: 14, margin: 0 }}>{t("databases.subtitle")}</p>
        </div>
        <Link href="/resources/new?kind=database" style={{ background: "var(--c-a)", color: "#0d0d11", fontWeight: 600, fontSize: 13, padding: "9px 14px", borderRadius: "var(--r1)", textDecoration: "none" }}>
          {t("databases.newDatabase")}
        </Link>
      </div>

      {isLoading ? (
        <Spinner />
      ) : (
        <>
          <TagFilter all={allTags} selected={selectedTags} onChange={setSelectedTags} />
          <div style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r2)", overflow: "hidden" }}>
            {visible.map((d) => (
              <Link key={d.id} href={`/databases/${d.id}`} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderTop: "1px solid var(--c-bd)", textDecoration: "none", color: "var(--c-tx)" }}>
                <span style={{ width: 9, height: 9, borderRadius: "50%", background: dbColor(d.status) }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 14, display: "flex", alignItems: "center", gap: 8 }}>
                    {d.name}
                    <TagChips tags={d.tags} />
                  </div>
                  <div className="mono" style={{ fontSize: 11, color: "var(--c-tx3)" }}>{engineLabel(d.engine)} · {d.version}</div>
                </div>
                <span style={{ fontSize: 12, color: dbColor(d.status), fontWeight: 600 }}>{d.status}</span>
              </Link>
            ))}
            {visible.length === 0 && (
              <EmptyState
                icon={Database}
                title={t("databases.emptyTitle")}
                action={<Link href="/resources/new?kind=database"><Btn>{t("databases.newDatabase")}</Btn></Link>}
              >
                {t("databases.empty")}
              </EmptyState>
            )}
          </div>
        </>
      )}
    </div>
  );
}
