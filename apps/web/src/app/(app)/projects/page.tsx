"use client";

import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import { useT } from "../../../i18n/provider";
import { Card, Spinner } from "../../../components/ui";

const field: React.CSSProperties = {
  padding: "8px 10px",
  background: "var(--c-el)",
  border: "1px solid var(--c-bd)",
  borderRadius: "var(--r1)",
  color: "var(--c-tx)",
  fontSize: 13,
  fontFamily: "inherit",
};

export default function ProjectsPage() {
  const t = useT();
  const qc = useQueryClient();
  const { data: projects = [], isLoading } = useQuery({ queryKey: ["projects"], queryFn: () => api.listProjects() });
  const { data: teams = [] } = useQuery({ queryKey: ["teams"], queryFn: () => api.listTeams() });

  const [name, setName] = useState("");
  const [teamId, setTeamId] = useState("");
  const activeTeam = teamId || teams[0]?.id || "";
  const create = useMutation({
    mutationFn: () => api.createProject(activeTeam, name),
    onSuccess: () => {
      setName("");
      qc.invalidateQueries({ queryKey: ["projects"] });
    },
  });

  return (
    <div style={{ padding: 28 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 4px" }}>{t("projects.title")}</h1>
      <p style={{ color: "var(--c-tx3)", fontSize: 14, margin: "0 0 22px" }}>{t("projects.subtitle")}</p>

      <Card style={{ padding: 16, marginBottom: 20 }}>
        <form
          onSubmit={(e) => { e.preventDefault(); create.mutate(); }}
          style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}
        >
          <input style={{ ...field, flex: 1, minWidth: 160 }} placeholder={t("projects.name")} value={name} onChange={(e) => setName(e.target.value)} required />
          <select style={field} value={activeTeam} onChange={(e) => setTeamId(e.target.value)}>
            {teams.map((tm) => <option key={tm.id} value={tm.id}>{tm.name}</option>)}
          </select>
          <button type="submit" disabled={create.isPending || !activeTeam} style={{ ...field, background: "var(--c-a)", color: "#0d0d11", fontWeight: 600, cursor: "pointer" }}>
            {create.isPending ? "…" : t("projects.create")}
          </button>
        </form>
        {create.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(create.error as Error).message}</div>}
      </Card>

      {isLoading ? (
        <Spinner />
      ) : (
        <div style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r2)", overflow: "hidden" }}>
          {projects.map((p) => {
            const apps = p.environments.reduce((n, e) => n + e.appCount, 0);
            const dbs = p.environments.reduce((n, e) => n + e.dbCount, 0);
            return (
              <Link key={p.id} href={`/projects/${p.id}`} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderTop: "1px solid var(--c-bd)", textDecoration: "none", color: "var(--c-tx)" }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{p.name}</div>
                  <div className="mono" style={{ fontSize: 11, color: "var(--c-tx3)" }}>
                    {p.environments.length} env · {apps} apps · {dbs} dbs
                  </div>
                </div>
                <span style={{ fontSize: 12, color: "var(--c-tx3)" }}>→</span>
              </Link>
            );
          })}
          {projects.length === 0 && (
            <div style={{ padding: 32, textAlign: "center", color: "var(--c-tx3)", fontSize: 13 }}>{t("projects.empty")}</div>
          )}
        </div>
      )}
    </div>
  );
}
