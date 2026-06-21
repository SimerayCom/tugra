"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Box, Database, FileCode2, GitBranch, Layers } from "lucide-react";
import { api } from "../../../../lib/api";
import type { DbEngine } from "../../../../lib/types";
import { engineLabel } from "../../../../lib/databases";
import { TemplateLogo } from "../../../../lib/template-icons";
import { useT } from "../../../../i18n/provider";
import { BackLink, Btn, Card, Spinner } from "../../../../components/ui";
import { Field, Select, TextInput } from "../../../../components/form";

const ENGINES: DbEngine[] = ["POSTGRES", "MYSQL", "MARIADB", "REDIS", "KEYDB", "DRAGONFLY", "MONGO", "CLICKHOUSE"];

// display order for the one-click app-store categories
const CATEGORY_ORDER = [
  "cms",
  "productivity",
  "developer",
  "analytics",
  "automation",
  "monitoring",
  "security",
  "database",
  "tools",
];

type Sel =
  | { group: "app"; source: "IMAGE" }
  | { group: "app"; source: "GIT"; build: "NIXPACKS" | "DOCKERFILE" }
  | { group: "service" }
  | { group: "db"; engine: DbEngine }
  | { group: "template"; slug: string; name: string }
  | null;

function Wizard() {
  const t = useT();
  const router = useRouter();
  const sp = useSearchParams();

  const { data: projects = [], isLoading } = useQuery({ queryKey: ["projects"], queryFn: () => api.listProjects() });
  const { data: servers = [] } = useQuery({ queryKey: ["servers"], queryFn: () => api.listServers() });
  const { data: templates = [] } = useQuery({ queryKey: ["templates"], queryFn: () => api.listTemplates() });

  const [projectId, setProjectId] = useState(sp.get("project") ?? "");
  const [envId, setEnvId] = useState(sp.get("env") ?? "");
  useEffect(() => {
    if (!projectId && projects.length) setProjectId(projects[0].id);
  }, [projects, projectId]);
  const project = projects.find((p) => p.id === projectId);
  useEffect(() => {
    if (project && !project.environments.some((e) => e.id === envId)) setEnvId(project.environments[0]?.id ?? "");
  }, [project, envId]);

  const [sel, setSel] = useState<Sel>(null);
  const [q, setQ] = useState("");

  // config fields
  const [name, setName] = useState("");
  const [serverId, setServerId] = useState("");
  const [image, setImage] = useState("");
  const [gitUrl, setGitUrl] = useState("");
  const [gitBranch, setGitBranch] = useState("");
  const [buildType, setBuildType] = useState<"NIXPACKS" | "DOCKERFILE" | "STATIC">("NIXPACKS");
  const [buildCommand, setBuildCommand] = useState("");
  const [outputDir, setOutputDir] = useState("");
  const [composeFile, setComposeFile] = useState("");
  const [hostPort, setHostPort] = useState("");
  const [domain, setDomain] = useState("");
  const [version, setVersion] = useState("");

  const noServer = servers.length === 0;

  const pick = (s: Sel) => {
    setSel(s);
    if (s?.group === "app" && s.source === "GIT") setBuildType(s.build);
    if (s?.group === "template") setName(s.slug);
  };

  const create = useMutation({
    mutationFn: async (): Promise<string> => {
      const environmentId = envId || undefined;
      if (sel?.group === "template") {
        const a = await api.createFromTemplate(sel.slug, { name, serverId, environmentId });
        return `/apps/${a.id}`;
      }
      if (sel?.group === "db") {
        const d = await api.createDatabase({ name, serverId, engine: sel.engine, version: version || undefined, hostPort: hostPort ? Number(hostPort) : undefined, environmentId });
        return `/databases/${d.id}`;
      }
      if (sel?.group === "service") {
        const a = await api.createApp({ name, serverId, source: "COMPOSE", composeFile, environmentId });
        return `/apps/${a.id}`;
      }
      // app
      const a = await api.createApp({
        name, serverId,
        source: sel?.group === "app" ? sel.source : "IMAGE",
        image: sel?.group === "app" && sel.source === "IMAGE" ? image : undefined,
        gitUrl: sel?.group === "app" && sel.source === "GIT" ? gitUrl : undefined,
        gitBranch: sel?.group === "app" && sel.source === "GIT" ? gitBranch || undefined : undefined,
        buildType: sel?.group === "app" && sel.source === "GIT" ? buildType : undefined,
        buildCommand: buildType === "STATIC" ? buildCommand || undefined : undefined,
        outputDir: buildType === "STATIC" ? outputDir || undefined : undefined,
        hostPort: hostPort ? Number(hostPort) : undefined,
        domain: domain || undefined,
        environmentId,
      });
      return `/apps/${a.id}`;
    },
    onSuccess: (href) => router.push(href),
  });

  if (isLoading) return <div style={{ padding: 28 }}><Spinner /></div>;

  const tile = (key: string, Icon: typeof Box, title: string, desc: string, onClick: () => void, brand?: React.ReactNode) => (
    <button
      key={key}
      type="button"
      onClick={onClick}
      style={{ display: "flex", alignItems: "center", gap: 12, textAlign: "left", padding: "12px 14px", borderRadius: "var(--r1)", cursor: "pointer", fontFamily: "inherit", background: "var(--c-el)", border: "1px solid var(--c-bd)", color: "var(--c-tx)" }}
    >
      {brand ?? <Icon size={22} color="var(--c-a)" />}
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>{title}</div>
        <div style={{ fontSize: 12, color: "var(--c-tx3)", overflow: "hidden", textOverflow: "ellipsis" }}>{desc}</div>
      </div>
    </button>
  );
  const grid: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 10, marginBottom: 18 };
  const groupTitle: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: "var(--c-tx3)", textTransform: "uppercase", letterSpacing: "0.06em", margin: "4px 0 8px" };

  return (
    <div style={{ padding: 28, maxWidth: 880 }}>
      <BackLink href="/projects" label={t("common.backTo", { target: t("nav.projects") })} />
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 4px" }}>{t("resources.newTitle")}</h1>
      <p style={{ color: "var(--c-tx3)", fontSize: 14, margin: "0 0 22px" }}>{t("resources.subtitle")}</p>

      {projects.length === 0 ? (
        <Card style={{ padding: 16, fontSize: 13, color: "var(--c-tx3)" }}>
          {t("resources.needProject")} <Link href="/projects" style={{ color: "var(--c-a)" }}>{t("resources.createProject")}</Link>
        </Card>
      ) : (
        <>
          {/* Destination */}
          <Card style={{ padding: 16, marginBottom: 18 }}>
            <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 12 }}>{t("resources.destination")}</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <Field label={t("resources.project")}>
                <Select value={projectId} onChange={setProjectId} options={projects.map((p) => ({ value: p.id, label: p.name }))} />
              </Field>
              <Field label={t("resources.environment")}>
                <Select value={envId} onChange={setEnvId} options={(project?.environments ?? []).map((e) => ({ value: e.id, label: e.name }))} />
              </Field>
            </div>
          </Card>

          {sel === null ? (
            <>
              <div style={groupTitle}>{t("resources.applications")}</div>
              <div style={grid}>
                {tile("img", Box, t("resources.dockerImage"), t("resources.dockerImageDesc"), () => pick({ group: "app", source: "IMAGE" }))}
                {tile("git", GitBranch, t("resources.publicRepo"), t("resources.publicRepoDesc"), () => pick({ group: "app", source: "GIT", build: "NIXPACKS" }))}
                {tile("dockerfile", FileCode2, t("resources.dockerfile"), t("resources.dockerfileDesc"), () => pick({ group: "app", source: "GIT", build: "DOCKERFILE" }))}
                {tile("compose", Layers, t("resources.compose"), t("resources.composeDesc"), () => pick({ group: "service" }))}
              </div>

              <div style={groupTitle}>{t("resources.databases")}</div>
              <div style={grid}>
                {ENGINES.map((e) => tile(e, Database, engineLabel(e), t("resources.databaseDesc"), () => pick({ group: "db", engine: e })))}
              </div>

              {templates.length > 0 && (() => {
                const needle = q.trim().toLowerCase();
                const matches = needle
                  ? templates.filter((tpl) =>
                      `${tpl.name} ${tpl.description} ${tpl.category}`.toLowerCase().includes(needle),
                    )
                  : templates;
                const cats = [...new Set(matches.map((tpl) => tpl.category))].sort(
                  (a, b) => CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b),
                );
                return (
                  <>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "4px 0 12px" }}>
                      <div style={{ ...groupTitle, margin: 0 }}>{t("resources.services")}</div>
                      <div style={{ flex: 1, maxWidth: 280 }}>
                        <TextInput value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("resources.searchServices")} />
                      </div>
                    </div>
                    {matches.length === 0 ? (
                      <div style={{ fontSize: 13, color: "var(--c-tx3)", marginBottom: 18 }}>{t("resources.noMatches")}</div>
                    ) : (
                      cats.map((cat) => (
                        <div key={cat}>
                          <div style={{ ...groupTitle, opacity: 0.8 }}>{t(`resources.cat_${cat}`)}</div>
                          <div style={grid}>
                            {matches
                              .filter((tpl) => tpl.category === cat)
                              .map((tpl) =>
                                tile(tpl.slug, Box, tpl.name, tpl.description, () => pick({ group: "template", slug: tpl.slug, name: tpl.name }), <TemplateLogo logo={tpl.logo} slug={tpl.slug} name={tpl.name} />),
                              )}
                          </div>
                        </div>
                      ))
                    )}
                  </>
                );
              })()}
            </>
          ) : (
            <Card style={{ padding: 16 }}>
              <button type="button" onClick={() => setSel(null)} style={{ background: "transparent", border: "none", color: "var(--c-lapis)", fontSize: 13, cursor: "pointer", fontFamily: "inherit", padding: 0, marginBottom: 14 }}>
                ← {t("resources.changeType")}
              </button>
              <form onSubmit={(e) => { e.preventDefault(); if (!noServer && name && serverId) create.mutate(); }}>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
                  <Field label={t("apps.name")} htmlFor="r-name">
                    <TextInput id="r-name" value={name} onChange={(e) => setName(e.target.value)} required />
                  </Field>
                  <Field label={t("apps.server")}>
                    <Select value={serverId} onChange={setServerId} required placeholder={t("apps.server")} options={servers.map((s) => ({ value: s.id, label: s.name }))} />
                  </Field>

                  {sel.group === "app" && sel.source === "IMAGE" && (
                    <Field label={t("apps.image")} style={{ gridColumn: "1 / -1" }}>
                      <TextInput value={image} onChange={(e) => setImage(e.target.value)} placeholder="nginx:alpine" required />
                    </Field>
                  )}
                  {sel.group === "app" && sel.source === "GIT" && (
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
                  {sel.group === "service" && (
                    <Field label={t("apps.compose")} style={{ gridColumn: "1 / -1" }}>
                      <textarea value={composeFile} onChange={(e) => setComposeFile(e.target.value)} placeholder={t("apps.composeFile")} required
                        style={{ width: "100%", minHeight: 140, padding: "8px 10px", background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", color: "var(--c-tx)", fontSize: 13, fontFamily: "var(--font-mono, monospace)", resize: "vertical", boxSizing: "border-box" }} />
                    </Field>
                  )}
                  {sel.group === "db" && (
                    <>
                      <Field label={t("databases.engine")}>
                        <TextInput value={engineLabel(sel.engine)} disabled />
                      </Field>
                      <Field label={t("databases.version")} hint={t("databases.versionHint")}>
                        <TextInput value={version} onChange={(e) => setVersion(e.target.value)} />
                      </Field>
                      <Field label={t("databases.hostPort")} hint={t("databases.hostPortHint")}>
                        <TextInput type="number" value={hostPort} onChange={(e) => setHostPort(e.target.value)} />
                      </Field>
                    </>
                  )}
                  {sel.group === "app" && (
                    <>
                      <Field label={t("apps.hostPort")}>
                        <TextInput type="number" value={hostPort} onChange={(e) => setHostPort(e.target.value)} />
                      </Field>
                      <Field label={t("apps.domain")}>
                        <TextInput value={domain} onChange={(e) => setDomain(e.target.value)} />
                      </Field>
                    </>
                  )}
                </div>
                <div style={{ marginTop: 14 }}>
                  {noServer ? (
                    <div style={{ fontSize: 13, color: "var(--c-tx3)" }}>
                      {t("resources.needServer")} <Link href="/servers/new" style={{ color: "var(--c-a)" }}>{t("resources.addServer")}</Link>
                    </div>
                  ) : (
                    <Btn type="submit" disabled={create.isPending || !name || !serverId}>{create.isPending ? "…" : t("resources.create")}</Btn>
                  )}
                </div>
                {create.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(create.error as Error).message}</div>}
              </form>
            </Card>
          )}
        </>
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
