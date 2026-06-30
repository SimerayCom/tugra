"use client";

import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Download, ScrollText } from "lucide-react";
import { api } from "../../../lib/api";
import { filterAudit, auditToCsv } from "../../../lib/audit";
import { useT } from "../../../i18n/provider";
import { Btn, Card, EmptyState, Spinner } from "../../../components/ui";
import { TextInput } from "../../../components/form";
import { useTeamScope } from "../../../components/team-scope";

function fmt(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString();
}

export default function AuditPage() {
  const t = useT();
  // Scope follows the global team switcher. null ("All teams") shows only your
  // own actions; picking a team shows that team's activity (if you admin it).
  const { teamId } = useTeamScope();
  const [q, setQ] = useState("");

  const { data, isLoading, hasNextPage, fetchNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: ["audit", teamId],
    queryFn: ({ pageParam }) => api.listAudit(teamId ?? undefined, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  // Client-side filter narrows the already-loaded pages; "Load more" fetches older.
  const entries = data?.pages.flatMap((p) => p.entries) ?? [];

  const shown = filterAudit(entries, q);

  const exportCsv = () => {
    const blob = new Blob([auditToCsv(shown)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "audit-log.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div style={{ padding: "var(--page-pad)", maxWidth: 960 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 4px", display: "flex", alignItems: "center", gap: 8 }}>
        <ScrollText size={20} color="var(--c-a)" /> {t("audit.title")}
      </h1>
      <p style={{ color: "var(--c-tx3)", fontSize: 14, margin: "0 0 22px" }}>{t("audit.subtitle")}</p>

      {isLoading ? (
        <Spinner />
      ) : entries.length === 0 ? (
        <EmptyState icon={ScrollText} title={t("audit.emptyTitle")}>{t("audit.empty")}</EmptyState>
      ) : (
        <>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 14 }}>
            <div style={{ flex: 1, minWidth: 200 }}>
              <TextInput value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("audit.search")} />
            </div>
            <span style={{ fontSize: 12, color: "var(--c-tx3)" }}>{shown.length}/{entries.length}</span>
            <Btn variant="ghost" onClick={exportCsv} disabled={shown.length === 0}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><Download size={14} /> {t("audit.exportCsv")}</span>
            </Btn>
          </div>
          {shown.length === 0 ? (
            <EmptyState icon={ScrollText} title={t("audit.noMatchTitle")}>{t("audit.noMatch")}</EmptyState>
          ) : (
          <Card>
          <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--c-tx3)" }}>
                <th style={{ padding: "8px 10px", fontWeight: 600 }}>{t("audit.actor")}</th>
                <th style={{ padding: "8px 10px", fontWeight: 600 }}>{t("audit.action")}</th>
                <th style={{ padding: "8px 10px", fontWeight: 600 }}>{t("audit.target")}</th>
                <th style={{ padding: "8px 10px", fontWeight: 600 }}>{t("audit.time")}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((e) => (
                <tr key={e.id} style={{ borderTop: "1px solid var(--c-bd)" }}>
                  <td style={{ padding: "8px 10px", color: "var(--c-tx2)" }}>{e.actor}</td>
                  <td style={{ padding: "8px 10px" }}>
                    <code style={{ fontSize: 12 }}>{e.action}</code>
                  </td>
                  <td style={{ padding: "8px 10px", color: "var(--c-tx3)", fontFamily: "var(--font-mono, monospace)", fontSize: 12 }}>
                    {e.target ?? "—"}
                  </td>
                  <td style={{ padding: "8px 10px", color: "var(--c-tx3)", whiteSpace: "nowrap" }}>{fmt(e.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </Card>
          )}
          {hasNextPage && (
            <div style={{ display: "flex", justifyContent: "center", marginTop: 14 }}>
              <Btn variant="ghost" onClick={() => fetchNextPage()} disabled={isFetchingNextPage}>
                {isFetchingNextPage ? "…" : t("audit.loadMore")}
              </Btn>
            </div>
          )}
        </>
      )}
    </div>
  );
}
