"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import { dbColor, engineLabel } from "../../../lib/databases";
import { useT } from "../../../i18n/provider";
import { Spinner } from "../../../components/ui";
import { TagChips, TagFilter } from "../../../components/tags";

export default function DatabasesPage() {
  const t = useT();
  const { data: databases = [], isLoading } = useQuery({
    queryKey: ["databases"],
    queryFn: () => api.listDatabases(),
    refetchInterval: 8000,
  });

  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const allTags = [...new Set(databases.flatMap((d) => d.tags))].sort();
  const visible = databases.filter((d) => selectedTags.every((tag) => d.tags.includes(tag)));

  return (
    <div style={{ padding: 28 }}>
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
              <div style={{ padding: 32, textAlign: "center", color: "var(--c-tx3)", fontSize: 13 }}>{t("databases.empty")}</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
