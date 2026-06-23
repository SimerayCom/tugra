"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ScrollText } from "lucide-react";
import { api } from "../../../lib/api";
import { useT } from "../../../i18n/provider";
import { Card, EmptyState, Spinner } from "../../../components/ui";
import { Select } from "../../../components/form";

function fmt(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString();
}

export default function AuditPage() {
  const t = useT();
  const { data: teams = [] } = useQuery({ queryKey: ["teams"], queryFn: () => api.listTeams() });
  const [teamId, setTeamId] = useState("");
  const activeTeam = teamId || teams[0]?.id || "";

  const { data: entries = [], isLoading } = useQuery({
    queryKey: ["audit", activeTeam],
    queryFn: () => api.listAudit(activeTeam || undefined),
    enabled: teams.length > 0,
  });

  return (
    <div style={{ padding: 28, maxWidth: 960 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 4px", display: "flex", alignItems: "center", gap: 8 }}>
        <ScrollText size={20} color="var(--c-a)" /> {t("audit.title")}
      </h1>
      <p style={{ color: "var(--c-tx3)", fontSize: 14, margin: "0 0 22px" }}>{t("audit.subtitle")}</p>

      {teams.length > 1 && (
        <div style={{ maxWidth: 280, marginBottom: 18 }}>
          <Select
            value={activeTeam}
            onChange={setTeamId}
            options={teams.map((tm) => ({ value: tm.id, label: tm.name }))}
            placeholder={t("audit.team")}
          />
        </div>
      )}

      {isLoading ? (
        <Spinner />
      ) : entries.length === 0 ? (
        <EmptyState>{t("audit.empty")}</EmptyState>
      ) : (
        <Card>
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
              {entries.map((e) => (
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
        </Card>
      )}
    </div>
  );
}
