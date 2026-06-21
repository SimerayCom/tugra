"use client";

import Link from "next/link";
import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../../lib/api";
import type { AppStatus, DbStatus, Environment, ProjectResource } from "../../../../lib/types";
import { appColor } from "../../../../lib/apps";
import { dbColor } from "../../../../lib/databases";
import { useT } from "../../../../i18n/provider";
import { BackLink, Btn, Card, Spinner } from "../../../../components/ui";
import { TagChips } from "../../../../components/tags";

const field: React.CSSProperties = {
  padding: "8px 10px",
  background: "var(--c-el)",
  border: "1px solid var(--c-bd)",
  borderRadius: "var(--r1)",
  color: "var(--c-tx)",
  fontSize: 13,
  fontFamily: "inherit",
};

export default function ProjectDetailPage() {
  const t = useT();
  const id = String(useParams().id);
  const qc = useQueryClient();
  const router = useRouter();

  const { data: project, isLoading } = useQuery({ queryKey: ["project", id], queryFn: () => api.getProject(id) });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["project", id] });

  const [envName, setEnvName] = useState("");
  const addEnv = useMutation({
    mutationFn: () => api.addEnvironment(id, envName),
    onSuccess: () => { setEnvName(""); invalidate(); },
  });
  const del = useMutation({
    mutationFn: () => api.deleteProject(id),
    onSuccess: () => router.replace("/projects"),
  });

  if (isLoading || !project) return <div style={{ padding: 28 }}><Spinner /></div>;
  const empty = project.environments.every((e) => e.appCount + e.dbCount === 0);

  return (
    <div style={{ padding: 28 }}>
      <BackLink href="/projects" label={t("common.backTo", { target: t("nav.projects") })} />
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>{project.name}</h1>
        <div style={{ flex: 1 }} />
        {project.canWrite && empty && (
          <Btn variant="danger" onClick={() => del.mutate()}>{t("projects.deleteProject")}</Btn>
        )}
      </div>

      <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 12 }}>{t("projects.environments")}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {project.environments.map((env) => (
          <EnvironmentBlock key={env.id} env={env} projectId={id} canWrite={project.canWrite} onChange={invalidate} />
        ))}
      </div>

      {project.canWrite && (
        <Card style={{ padding: 16, marginTop: 16 }}>
          <form onSubmit={(e) => { e.preventDefault(); addEnv.mutate(); }} style={{ display: "flex", gap: 8 }}>
            <input style={{ ...field, flex: 1 }} placeholder={t("projects.environmentName")} value={envName} onChange={(e) => setEnvName(e.target.value)} required />
            <Btn onClick={() => addEnv.mutate()} disabled={addEnv.isPending || !envName}>{t("projects.addEnvironment")}</Btn>
          </form>
        </Card>
      )}
    </div>
  );
}

function EnvironmentBlock({ env, projectId, canWrite, onChange }: { env: Environment; projectId: string; canWrite: boolean; onChange: () => void }) {
  const t = useT();
  const [query, setQuery] = useState("");
  const all = env.resources ?? [];
  const empty = all.length === 0;
  const q = query.toLowerCase();
  const match = (r: ProjectResource) => r.name.toLowerCase().includes(q) || (r.url ?? "").toLowerCase().includes(q);
  const apps = all.filter((r) => r.kind === "app" && match(r));
  const dbs = all.filter((r) => r.kind === "database" && match(r));
  const remove = useMutation({ mutationFn: () => api.deleteEnvironment(env.id), onSuccess: onChange });
  const newHref = (kind: "app" | "database") => `/resources/new?project=${projectId}&env=${env.id}&kind=${kind}`;
  const chip: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: "var(--c-a)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: "3px 10px", textDecoration: "none" };
  return (
    <Card style={{ padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <span style={{ fontWeight: 600, fontSize: 14 }}>{env.name}</span>
        <span className="mono" style={{ fontSize: 11, color: "var(--c-tx3)" }}>{env.appCount} apps · {env.dbCount} dbs</span>
        <div style={{ flex: 1 }} />
        {canWrite && (
          <>
            <Link href={newHref("app")} style={chip}>{t("projects.newApp")}</Link>
            <Link href={newHref("database")} style={chip}>{t("projects.newDatabase")}</Link>
          </>
        )}
        {canWrite && empty && (
          <button
            onClick={() => remove.mutate()}
            title={t("projects.deleteProject")}
            style={{ background: "transparent", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", color: "var(--c-tx3)", fontSize: 11, cursor: "pointer", padding: "2px 8px", fontFamily: "inherit" }}
          >
            ×
          </button>
        )}
      </div>
      {!empty && (
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("projects.searchResources")}
          style={{ width: "100%", boxSizing: "border-box", padding: "7px 10px", marginBottom: 12, background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", color: "var(--c-tx)", fontSize: 13, fontFamily: "inherit" }}
        />
      )}
      {empty && <div style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("projects.noResources")}</div>}
      <ResourceGroup title={t("projects.applications")} items={apps} />
      <ResourceGroup title={t("projects.databases")} items={dbs} />
    </Card>
  );
}

function ResourceGroup({ title, items }: { title: string; items: ProjectResource[] }) {
  if (!items.length) return null;
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--c-tx3)", textTransform: "uppercase", letterSpacing: "0.05em", margin: "4px 0 6px" }}>{title}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {items.map((r) => (
          <Link
            key={`${r.kind}:${r.id}`}
            href={r.kind === "app" ? `/apps/${r.id}` : `/databases/${r.id}`}
            style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: "var(--c-tx)", textDecoration: "none", padding: "8px 10px", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)" }}
          >
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: r.kind === "app" ? appColor(r.status as AppStatus) : dbColor(r.status as DbStatus), flexShrink: 0 }} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontWeight: 600 }}>{r.name}</span>
                <TagChips tags={r.tags} />
              </div>
              <div className="mono" style={{ fontSize: 11, color: "var(--c-tx3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {r.url ? r.url : r.engine ?? ""}
                {r.serverName ? ` · ${r.serverName}` : ""}
              </div>
            </div>
            <span style={{ fontSize: 11, color: "var(--c-tx3)" }}>{r.status}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
