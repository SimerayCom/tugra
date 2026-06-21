"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../../../../lib/api";
import type { DbEngine } from "../../../../lib/types";
import { engineLabel } from "../../../../lib/databases";
import { useT } from "../../../../i18n/provider";
import { BackLink, Btn, Card, Spinner } from "../../../../components/ui";
import { Field, Select, TextInput } from "../../../../components/form";

const ENGINES: DbEngine[] = ["POSTGRES", "MYSQL", "MARIADB", "REDIS", "KEYDB", "DRAGONFLY", "MONGO", "CLICKHOUSE"];

function Wizard() {
  const t = useT();
  const router = useRouter();
  const sp = useSearchParams();

  const { data: projects = [], isLoading } = useQuery({ queryKey: ["projects"], queryFn: () => api.listProjects() });
  const { data: servers = [] } = useQuery({ queryKey: ["servers"], queryFn: () => api.listServers() });

  const qkind = sp.get("kind");
  const [kind, setKind] = useState<"app" | "service" | "database">(
    qkind === "database" ? "database" : qkind === "service" ? "service" : "app",
  );
  const [projectId, setProjectId] = useState(sp.get("project") ?? "");
  const [envId, setEnvId] = useState(sp.get("env") ?? "");

  useEffect(() => {
    if (!projectId && projects.length) setProjectId(projects[0].id);
  }, [projects, projectId]);
  const project = projects.find((p) => p.id === projectId);
  useEffect(() => {
    if (project && !project.environments.some((e) => e.id === envId)) {
      setEnvId(project.environments[0]?.id ?? "");
    }
  }, [project, envId]);

  // shared
  const [name, setName] = useState("");
  const [serverId, setServerId] = useState("");
  const [hostPort, setHostPort] = useState("");
  // app
  const [source, setSource] = useState<"IMAGE" | "GIT" | "COMPOSE">("IMAGE");
  const [image, setImage] = useState("");
  const [gitUrl, setGitUrl] = useState("");
  const [gitBranch, setGitBranch] = useState("");
  const [buildType, setBuildType] = useState<"NIXPACKS" | "DOCKERFILE" | "STATIC">("NIXPACKS");
  const [buildCommand, setBuildCommand] = useState("");
  const [outputDir, setOutputDir] = useState("");
  const [composeFile, setComposeFile] = useState("");
  const [domain, setDomain] = useState("");
  // db
  const [engine, setEngine] = useState<DbEngine>("POSTGRES");
  const [version, setVersion] = useState("");

  const noServer = servers.length === 0;

  const create = useMutation({
    mutationFn: async (): Promise<string> => {
      const environmentId = envId || undefined;
      if (kind === "service") {
        const a = await api.createApp({ name, serverId, source: "COMPOSE", composeFile, environmentId });
        return `/apps/${a.id}`;
      }
      if (kind === "app") {
        const a = await api.createApp({
          name,
          serverId,
          source,
          image: source === "IMAGE" ? image : undefined,
          gitUrl: source === "GIT" ? gitUrl : undefined,
          gitBranch: source === "GIT" ? gitBranch || undefined : undefined,
          buildType: source === "GIT" ? buildType : undefined,
          buildCommand: source === "GIT" && buildType === "STATIC" ? buildCommand || undefined : undefined,
          outputDir: source === "GIT" && buildType === "STATIC" ? outputDir || undefined : undefined,
          hostPort: hostPort ? Number(hostPort) : undefined,
          domain: domain || undefined,
          environmentId,
        });
        return `/apps/${a.id}`;
      }
      const d = await api.createDatabase({
        name,
        serverId,
        engine,
        version: version || undefined,
        hostPort: hostPort ? Number(hostPort) : undefined,
        environmentId,
      });
      return `/databases/${d.id}`;
    },
    onSuccess: (href) => router.push(href),
  });

  if (isLoading) return <div style={{ padding: 28 }}><Spinner /></div>;

  return (
    <div style={{ padding: 28, maxWidth: 720 }}>
      <BackLink href="/projects" label={t("common.backTo", { target: t("nav.projects") })} />
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 4px" }}>{t("resources.newTitle")}</h1>
      <p style={{ color: "var(--c-tx3)", fontSize: 14, margin: "0 0 22px" }}>{t("resources.subtitle")}</p>

      {projects.length === 0 ? (
        <Card style={{ padding: 16, fontSize: 13, color: "var(--c-tx3)" }}>
          {t("resources.needProject")}{" "}
          <Link href="/projects" style={{ color: "var(--c-a)" }}>{t("resources.createProject")}</Link>
        </Card>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); if (!noServer && name && serverId) create.mutate(); }}>
          {/* Destination */}
          <Card style={{ padding: 16, marginBottom: 16 }}>
            <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 12 }}>{t("resources.destination")}</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <Field label={t("resources.project")}>
                <Select value={projectId} onChange={setProjectId}
                  options={projects.map((p) => ({ value: p.id, label: p.name }))} />
              </Field>
              <Field label={t("resources.environment")}>
                <Select value={envId} onChange={setEnvId}
                  options={(project?.environments ?? []).map((e) => ({ value: e.id, label: e.name }))} />
              </Field>
            </div>
          </Card>

          {/* Type */}
          <Card style={{ padding: 16, marginBottom: 16 }}>
            <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 12 }}>{t("resources.type")}</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
              {(["app", "service", "database"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setKind(k)}
                  style={{
                    textAlign: "left", padding: "12px 14px", borderRadius: "var(--r1)", cursor: "pointer", fontFamily: "inherit",
                    background: kind === k ? "var(--c-ad)" : "var(--c-el)",
                    border: `1px solid ${kind === k ? "var(--c-a)" : "var(--c-bd)"}`,
                    color: "var(--c-tx)",
                  }}
                >
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{t(`resources.${k}`)}</div>
                  <div style={{ fontSize: 12, color: "var(--c-tx3)", marginTop: 2 }}>{t(`resources.${k}Desc`)}</div>
                </button>
              ))}
            </div>
          </Card>

          {/* Config */}
          <Card style={{ padding: 16, marginBottom: 16 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
              <Field label={t("apps.name")} htmlFor="r-name">
                <TextInput id="r-name" value={name} onChange={(e) => setName(e.target.value)} required />
              </Field>
              <Field label={t("apps.server")}>
                <Select value={serverId} onChange={setServerId} required placeholder={t("apps.server")}
                  options={servers.map((s) => ({ value: s.id, label: s.name }))} />
              </Field>

              {kind === "app" && (
                <>
                  <Field label={t("apps.source")}>
                    <Select value={source} onChange={(v) => setSource(v as "IMAGE" | "GIT")}
                      options={[
                        { value: "IMAGE", label: t("apps.sourceImage") },
                        { value: "GIT", label: t("apps.sourceGit") },
                      ]} />
                  </Field>
                  {source === "IMAGE" && (
                    <Field label={t("apps.image")} style={{ gridColumn: "1 / -1" }}>
                      <TextInput value={image} onChange={(e) => setImage(e.target.value)} placeholder="nginx:alpine" required />
                    </Field>
                  )}
                  {source === "GIT" && (
                    <>
                      <Field label={t("apps.gitUrl")} style={{ gridColumn: "1 / -1" }}>
                        <TextInput value={gitUrl} onChange={(e) => setGitUrl(e.target.value)} required />
                      </Field>
                      <Field label={t("apps.branch")}>
                        <TextInput value={gitBranch} onChange={(e) => setGitBranch(e.target.value)} placeholder="main" />
                      </Field>
                      <Field label={t("apps.buildType")}>
                        <Select value={buildType} onChange={(v) => setBuildType(v as "NIXPACKS" | "DOCKERFILE" | "STATIC")}
                          options={[
                            { value: "NIXPACKS", label: t("apps.nixpacks") },
                            { value: "DOCKERFILE", label: t("apps.dockerfile") },
                            { value: "STATIC", label: t("apps.static") },
                          ]} />
                      </Field>
                      {buildType === "STATIC" && (
                        <>
                          <Field label={t("apps.buildCommand")}>
                            <TextInput value={buildCommand} onChange={(e) => setBuildCommand(e.target.value)} />
                          </Field>
                          <Field label={t("apps.outputDir")}>
                            <TextInput value={outputDir} onChange={(e) => setOutputDir(e.target.value)} />
                          </Field>
                        </>
                      )}
                    </>
                  )}
                  <Field label={t("apps.hostPort")}>
                    <TextInput type="number" value={hostPort} onChange={(e) => setHostPort(e.target.value)} />
                  </Field>
                  <Field label={t("apps.domain")}>
                    <TextInput value={domain} onChange={(e) => setDomain(e.target.value)} />
                  </Field>
                </>
              )}

              {kind === "service" && (
                <Field label={t("apps.compose")} style={{ gridColumn: "1 / -1" }}>
                  <textarea
                    value={composeFile}
                    onChange={(e) => setComposeFile(e.target.value)}
                    placeholder={t("apps.composeFile")}
                    required
                    style={{ width: "100%", minHeight: 140, padding: "8px 10px", background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", color: "var(--c-tx)", fontSize: 13, fontFamily: "var(--font-mono, monospace)", resize: "vertical", boxSizing: "border-box" }}
                  />
                </Field>
              )}

              {kind === "database" && (
                <>
                  <Field label={t("databases.engine")}>
                    <Select value={engine} onChange={(v) => setEngine(v as DbEngine)}
                      options={ENGINES.map((en) => ({ value: en, label: engineLabel(en) }))} />
                  </Field>
                  <Field label={t("databases.version")} hint={t("databases.versionHint")}>
                    <TextInput value={version} onChange={(e) => setVersion(e.target.value)} />
                  </Field>
                  <Field label={t("databases.hostPort")} hint={t("databases.hostPortHint")}>
                    <TextInput type="number" value={hostPort} onChange={(e) => setHostPort(e.target.value)} />
                  </Field>
                </>
              )}
            </div>
          </Card>

          {noServer ? (
            <div style={{ fontSize: 13, color: "var(--c-tx3)" }}>
              {t("resources.needServer")} <Link href="/servers/new" style={{ color: "var(--c-a)" }}>{t("resources.addServer")}</Link>
            </div>
          ) : (
            <Btn type="submit" disabled={create.isPending || !name || !serverId}>
              {create.isPending ? "…" : t("resources.create")}
            </Btn>
          )}
          {create.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(create.error as Error).message}</div>}
        </form>
      )}
    </div>
  );
}

export default function NewResourcePage() {
  return (
    <Suspense fallback={<div style={{ padding: 28 }}><Spinner /></div>}>
      <Wizard />
    </Suspense>
  );
}
