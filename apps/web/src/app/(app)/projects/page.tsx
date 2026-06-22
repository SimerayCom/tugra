"use client";

import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, FolderTree } from "lucide-react";
import { api } from "../../../lib/api";
import { useT } from "../../../i18n/provider";
import { Badge, Card, Spinner } from "../../../components/ui";

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
                <span style={{ width: 36, height: 36, borderRadius: 8, background: "rgba(255,255,255,0.06)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <FolderTree size={18} color="var(--c-a)" />
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{p.name}</div>
                  <div style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
                    <Badge>{p.environments.length} env</Badge>
                    <Badge>{apps} apps</Badge>
                    <Badge>{dbs} dbs</Badge>
                  </div>
                </div>
                <ChevronRight size={16} color="var(--c-tx3)" />
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
