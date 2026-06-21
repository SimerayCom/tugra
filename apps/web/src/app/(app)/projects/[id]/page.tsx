"use client";

import Link from "next/link";
import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../../lib/api";
import type { Environment } from "../../../../lib/types";
import { useT } from "../../../../i18n/provider";
import { BackLink, Btn, Card, Spinner } from "../../../../components/ui";

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
  const empty = (env.resources?.length ?? 0) === 0;
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
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {(env.resources ?? []).map((r) => (
          <Link
            key={`${r.kind}:${r.id}`}
            href={r.kind === "app" ? `/apps/${r.id}` : `/databases/${r.id}`}
            style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--c-tx)", textDecoration: "none" }}
          >
            <span className="mono" style={{ fontSize: 10, color: "var(--c-tx3)", width: 64 }}>{r.kind}</span>
            <span style={{ flex: 1 }}>{r.name}</span>
            <span style={{ fontSize: 11, color: "var(--c-tx3)" }}>{r.status}</span>
          </Link>
        ))}
        {empty && <div style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("projects.noResources")}</div>}
      </div>
    </Card>
  );
}
