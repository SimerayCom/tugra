"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Box, Database, ExternalLink, Server } from "lucide-react";
import { SiDocker, SiGit } from "@icons-pack/react-simple-icons";
import { api } from "../../../../lib/api";
import type { DbEngine, ServerStatus } from "../../../../lib/types";
import { engineLabel, engineVersions } from "../../../../lib/databases";
import { TemplateLogo } from "../../../../lib/template-icons";
import { TemplateGrid } from "../../../../components/template-grid";
import { wizardStep } from "../../../../lib/wizard-step";
import { parseKind, visibleGroups, backTarget, defaultProjectId, defaultEnvId, type ResourceKind } from "../../../../lib/resource-new";
import { scopeByTeam } from "../../../../lib/team-scope";
import { useT } from "../../../../i18n/provider";
import { BackLink, Btn, Card, Spinner, StatusPill } from "../../../../components/ui";
import { Field, Select, TextInput } from "../../../../components/form";

const serverColor = (s: ServerStatus) =>
  s === "ONLINE" ? "var(--c-g)" : s === "PENDING" ? "var(--c-am)" : "var(--c-r)";

const ENGINES: DbEngine[] = ["POSTGRES", "MYSQL", "MARIADB", "REDIS", "KEYDB", "DRAGONFLY", "MONGO", "CLICKHOUSE"];

// vendored brand icon per engine (KeyDB/Dragonfly have none → generic glyph)
const ENGINE_LOGO: Partial<Record<DbEngine, string>> = {
  POSTGRES: "postgresql",
  MYSQL: "mysql",
  MARIADB: "mariadb",
  REDIS: "redis",
  KEYDB: "keydb",
  DRAGONFLY: "dragonfly",
  MONGO: "mongodb",
  CLICKHOUSE: "clickhouse",
};

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
  const { data: servers = [], isSuccess: serversLoaded } = useQuery({ queryKey: ["servers"], queryFn: () => api.listServers() });
  const { data: templates = [] } = useQuery({ queryKey: ["templates"], queryFn: () => api.listTemplates() });
  const { data: gitSources = [] } = useQuery({ queryKey: ["gitSources"], queryFn: () => api.listGitSources() });

  const [serverId, setServerId] = useState(sp.get("server") ?? "");
  // Drop an invalid ?server= (deleted, or not one of yours) once servers load.
  // Gate on isSuccess, not servers.length, so it also clears when the user has
  // zero servers — and never clears a valid pin before the query resolves.
  useEffect(() => {
    if (serverId && serversLoaded && !servers.some((s) => s.id === serverId)) setServerId("");
  }, [servers, serversLoaded, serverId]);
  const pinnedServer = servers.find((s) => s.id === serverId);

  const [projectId, setProjectId] = useState(sp.get("project") ?? "");
  const [envId, setEnvId] = useState(sp.get("env") ?? "");
  // Target project and deployment server always share a team: scope the project
  // options to the pinned server's team (and the server grid to the project's team).
  const projectPool = scopeByTeam(projects, pinnedServer?.teamId ?? null);
  useEffect(() => {
    if (!projectId || !projectPool.some((p) => p.id === projectId)) {
      const next = defaultProjectId(projectPool);
      if (next && next !== projectId) setProjectId(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinnedServer?.teamId, projects, projectId]);
  const project = projectPool.find((p) => p.id === projectId);
  useEffect(() => {
    if (project && !project.environments.some((e) => e.id === envId)) setEnvId(defaultEnvId(project));
  }, [project, envId]);
  const serverPool = scopeByTeam(servers, project?.teamId ?? null);

  const [sel, setSel] = useState<Sel>(null);
  const [kindFilter, setKindFilter] = useState<ResourceKind | null>(parseKind(sp.get("kind")));
  const [editDest, setEditDest] = useState(false);

  // config fields
  const [name, setName] = useState("");
  const [image, setImage] = useState("");
  const [gitUrl, setGitUrl] = useState("");
  const [gitBranch, setGitBranch] = useState("");
  const [buildType, setBuildType] = useState<"NIXPACKS" | "DOCKERFILE" | "STATIC" | "RAILPACK" | "HEROKU">("NIXPACKS");
  const [buildCommand, setBuildCommand] = useState("");
  const [outputDir, setOutputDir] = useState("");
  const [composeFile, setComposeFile] = useState("");
  const [hostPort, setHostPort] = useState("");
  const [domain, setDomain] = useState("");
  const [version, setVersion] = useState("");
  const [gitSourceId, setGitSourceId] = useState("");

  const { data: sourceRepos = [] } = useQuery({
    queryKey: ["sourceRepos", gitSourceId],
    queryFn: () => api.listSourceRepos(gitSourceId),
    enabled: !!gitSourceId,
  });

  const noServer = servers.length === 0;

  const projectParam = sp.get("project");
  const vg = visibleGroups(kindFilter);
  const bt = backTarget({ projectParam, kind: kindFilter });
  const backName =
    bt.key === "project"
      ? projects.find((p) => p.id === projectParam)?.name ?? t("nav.projects")
      : bt.key === "apps"
        ? t("nav.apps")
        : bt.key === "databases"
          ? t("nav.databases")
          : t("nav.projects");

  const pick = (s: Sel) => {
    setSel(s);
    if (s?.group === "app" && s.source === "GIT") setBuildType(s.build);
    if (s?.group === "template") setName(s.slug);
    if (s?.group === "db") setVersion(engineVersions(s.engine)[0] ?? "");
  };

  // Deep-link from the standalone App Store: /resources/new?template=<slug>
  // preselects that template once, landing the wizard on the server step.
  const appliedTpl = useRef(false);
  useEffect(() => {
    if (appliedTpl.current) return;
    const slug = sp.get("template");
    if (!slug || !templates.length) return;
    const tpl = templates.find((x) => x.slug === slug);
    if (!tpl) return;
    appliedTpl.current = true;
    pick({ group: "template", slug: tpl.slug, name: tpl.name });
  }, [templates, sp]);

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
        gitSourceId: sel?.group === "app" && sel.source === "GIT" && gitSourceId ? gitSourceId : undefined,
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

  if (isLoading) return <div style={{ padding: "var(--page-pad)" }}><Spinner /></div>;

  // Coolify-style "coolbox": logo square + name + 2-line description
  const logoBox: React.CSSProperties = {
    width: 52, height: 52, borderRadius: 10, background: "rgba(255,255,255,0.06)",
    display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
    overflow: "hidden", padding: 8, boxSizing: "border-box",
  };
  const card = (key: string, iconNode: React.ReactNode, title: string, desc: string, onClick: () => void, docHref?: string) => (
    <button
      key={key}
      type="button"
      onClick={onClick}
      title={desc}
      style={{ position: "relative", display: "flex", alignItems: "center", gap: 12, textAlign: "left", padding: 12, borderRadius: "var(--r1)", cursor: "pointer", fontFamily: "inherit", background: "var(--c-el)", border: "1px solid var(--c-bd)", color: "var(--c-tx)", width: "100%" }}
    >
      <span style={logoBox}>{iconNode}</span>
      <span style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
        <span style={{ fontWeight: 600, fontSize: 14 }}>{title}</span>
        <span style={{ fontSize: 12, color: "var(--c-tx3)", lineHeight: 1.35, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{desc}</span>
      </span>
      {docHref && (
        <a
          href={docHref}
          target="_blank"
          rel="noreferrer"
          title={t("resources.docTitle")}
          aria-label={t("resources.docTitle")}
          onClick={(e) => e.stopPropagation()}
          style={{ position: "absolute", top: 8, right: 8, display: "inline-flex", padding: 3, borderRadius: 6, color: "var(--c-tx3)" }}
        >
          <ExternalLink size={14} />
        </a>
      )}
    </button>
  );
  const lucide = (Icon: typeof Box) => <Icon size={26} color="var(--c-a)" />;
  const grid3: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12, marginBottom: 20 };
  const groupTitle: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: "var(--c-tx3)", textTransform: "uppercase", letterSpacing: "0.06em", margin: "4px 0 10px" };
  const subTitle: React.CSSProperties = { fontSize: 13, fontWeight: 600, color: "var(--c-tx)", margin: "0 0 8px" };
  const backLinkBtn: React.CSSProperties = { background: "transparent", border: "none", color: "var(--c-lapis)", fontSize: 13, cursor: "pointer", fontFamily: "inherit", padding: 0 };

  return (
    <div style={{ padding: "var(--page-pad)", maxWidth: sel === null ? 1040 : 880 }}>
      <BackLink href={bt.href} label={t("common.backTo", { target: backName })} />
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 4px" }}>{t("resources.newTitle")}</h1>
      <p style={{ color: "var(--c-tx3)", fontSize: 14, margin: "0 0 22px" }}>{t("resources.subtitle")}</p>

      {projects.length === 0 ? (
        <Card style={{ padding: 16, fontSize: 13, color: "var(--c-tx3)" }}>
          {t("resources.needProject")} <Link href="/projects" style={{ color: "var(--c-a)" }}>{t("resources.createProject")}</Link>
        </Card>
      ) : (
        <>
          {/* Creating-in context (compact; read-only when scoped via URL) */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 18, fontSize: 13 }}>
            <span style={{ color: "var(--c-tx3)" }}>{t("resources.creatingIn")}:</span>
            {projectParam && !editDest ? (
              <>
                <span style={{ fontWeight: 600 }}>{project?.name}</span>
                <span style={{ color: "var(--c-tx3)" }}>/</span>
                <span style={{ fontWeight: 600 }}>{project?.environments.find((e) => e.id === envId)?.name}</span>
                <button type="button" onClick={() => setEditDest(true)} style={backLinkBtn}>{t("resources.change")}</button>
              </>
            ) : (
              <span style={{ display: "inline-flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <Select value={projectId} onChange={setProjectId} options={projectPool.map((p) => ({ value: p.id, label: p.name }))} style={{ width: "auto", minWidth: 150 }} />
                <span style={{ color: "var(--c-tx3)" }}>/</span>
                <Select value={envId} onChange={setEnvId} options={(project?.environments ?? []).map((e) => ({ value: e.id, label: e.name }))} style={{ width: "auto", minWidth: 130 }} />
              </span>
            )}
          </div>

          {(() => {
            const cur = wizardStep(sel !== null, !!serverId);
            const steps = [t("resources.stepType"), t("resources.stepServer"), t("resources.stepConfigure")];
            const goto = (n: number) => { if (n === 1) setSel(null); else if (n === 2) setServerId(""); };
            return (
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 18, flexWrap: "wrap" }}>
                {steps.map((label, i) => {
                  const n = i + 1;
                  const done = n < cur;
                  const active = n === cur;
                  return (
                    <span key={n} style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                      <button
                        type="button"
                        disabled={!done}
                        onClick={() => done && goto(n)}
                        style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "transparent", border: "none", padding: 0, cursor: done ? "pointer" : "default", fontFamily: "inherit", color: active || done ? "var(--c-a)" : "var(--c-tx3)", fontWeight: active ? 700 : 500, fontSize: 13 }}
                      >
                        <span style={{ width: 20, height: 20, borderRadius: "50%", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, background: active || done ? "var(--c-a)" : "var(--c-el)", color: active || done ? "#0d0d11" : "var(--c-tx3)", border: "1px solid var(--c-bd)" }}>{n}</span>
                        {label}
                      </button>
                      {n < 3 && <span style={{ width: 24, height: 1, background: "var(--c-bd)" }} />}
                    </span>
                  );
                })}
              </div>
            );
          })()}

          {sel === null ? (
            <>
              {kindFilter && (
                <button type="button" onClick={() => setKindFilter(null)} style={{ ...backLinkBtn, marginBottom: 14 }}>← {t("resources.allTypes")}</button>
              )}
              {vg.app && (
              <>
              <div style={groupTitle}>{t("resources.applications")}</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 18, marginBottom: 20 }}>
                <div>
                  <div style={subTitle}>{t("resources.gitBased")}</div>
                  <div style={{ display: "grid", gap: 10 }}>
                    {card("git", <SiGit color="#F05032" size={26} />, t("resources.publicRepo"), t("resources.publicRepoDesc"), () => pick({ group: "app", source: "GIT", build: "NIXPACKS" }))}
                    {card("dockerfile", <SiDocker color="#2496ED" size={26} />, t("resources.dockerfile"), t("resources.dockerfileDesc"), () => pick({ group: "app", source: "GIT", build: "DOCKERFILE" }))}
                  </div>
                </div>
                <div>
                  <div style={subTitle}>{t("resources.dockerBased")}</div>
                  <div style={{ display: "grid", gap: 10 }}>
                    {card("img", <SiDocker color="#2496ED" size={26} />, t("resources.dockerImage"), t("resources.dockerImageDesc"), () => pick({ group: "app", source: "IMAGE" }))}
                    {card("compose", <SiDocker color="#2496ED" size={26} />, t("resources.compose"), t("resources.composeDesc"), () => pick({ group: "service" }))}
                  </div>
                </div>
              </div>
              </>
              )}

              {vg.db && (
              <>
              <div style={groupTitle}>{t("resources.databases")}</div>
              <div style={grid3}>
                {ENGINES.map((e) =>
                  card(
                    e,
                    ENGINE_LOGO[e] ? <TemplateLogo logo={ENGINE_LOGO[e]} slug={e} name={engineLabel(e)} size={36} /> : lucide(Database),
                    engineLabel(e),
                    t("resources.databaseDesc"),
                    () => pick({ group: "db", engine: e }),
                  ),
                )}
              </div>
              </>
              )}

              {vg.service && templates.length > 0 && (
                <>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8, margin: "4px 0 10px" }}>
                    <div style={{ ...groupTitle, margin: 0 }}>{t("resources.services")}</div>
                    <span style={{ fontSize: 11, color: "var(--c-tx3)" }}>· {templates.length}</span>
                  </div>
                  <TemplateGrid templates={templates} onPick={(tpl) => pick({ group: "template", slug: tpl.slug, name: tpl.name })} />
                </>
              )}
            </>
          ) : !serverId ? (
            <Card style={{ padding: 16 }}>
              <button type="button" onClick={() => setSel(null)} style={{ ...backLinkBtn, marginBottom: 14 }}>← {t("resources.changeType")}</button>
              <div style={groupTitle}>{t("resources.selectServer")}</div>
              {serverPool.length === 0 ? (
                <div style={{ fontSize: 13, color: "var(--c-tx3)" }}>
                  {t("resources.needServer")} <Link href="/servers/new" style={{ color: "var(--c-a)" }}>{t("resources.addServer")}</Link>
                </div>
              ) : (
                <div style={grid3}>
                  {serverPool.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => setServerId(s.id)}
                      style={{ display: "flex", alignItems: "center", gap: 12, textAlign: "left", padding: 12, borderRadius: "var(--r1)", cursor: "pointer", fontFamily: "inherit", background: "var(--c-el)", border: "1px solid var(--c-bd)", color: "var(--c-tx)", width: "100%" }}
                    >
                      <span style={logoBox}><Server size={22} color="var(--c-a)" /></span>
                      <span style={{ minWidth: 0, flex: 1 }}>
                        <span style={{ display: "block", fontWeight: 600, fontSize: 14 }}>{s.name}</span>
                        {s.hostname && <span className="mono" style={{ fontSize: 11, color: "var(--c-tx3)" }}>{s.hostname}</span>}
                      </span>
                      <StatusPill label={s.status} color={serverColor(s.status)} />
                    </button>
                  ))}
                </div>
              )}
            </Card>
          ) : (
            <Card style={{ padding: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 14, flexWrap: "wrap" }}>
                <button type="button" onClick={() => setSel(null)} style={backLinkBtn}>← {t("resources.changeType")}</button>
                <button type="button" onClick={() => setServerId("")} style={backLinkBtn}>← {t("resources.changeServer")}</button>
                <span style={{ fontSize: 12, color: "var(--c-tx3)", display: "inline-flex", alignItems: "center", gap: 5 }}>
                  <Server size={13} /> {servers.find((s) => s.id === serverId)?.name}
                </span>
              </div>
              <form onSubmit={(e) => { e.preventDefault(); if (name && serverId) create.mutate(); }}>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
                  <Field label={t("apps.name")} htmlFor="r-name">
                    <TextInput id="r-name" value={name} onChange={(e) => setName(e.target.value)} required />
                  </Field>

                  {sel.group === "app" && sel.source === "IMAGE" && (
                    <Field label={t("apps.image")} style={{ gridColumn: "1 / -1" }}>
                      <TextInput value={image} onChange={(e) => setImage(e.target.value)} placeholder="nginx:alpine" required />
                    </Field>
                  )}
                  {sel.group === "app" && sel.source === "GIT" && (
                    <>
                      {gitSources.length > 0 && (
                        <Field label={t("sources.source")}>
                          <Select
                            value={gitSourceId}
                            onChange={(v) => { setGitSourceId(v); setGitUrl(""); }}
                            options={[{ value: "", label: t("resources.publicRepo") }, ...gitSources.map((s) => ({ value: s.id, label: s.name }))]}
                          />
                        </Field>
                      )}
                      {gitSourceId ? (
                        <Field label={t("sources.repo")} style={{ gridColumn: "1 / -1" }}>
                          <Select
                            value={gitUrl}
                            onChange={setGitUrl}
                            placeholder={t("sources.repo")}
                            options={sourceRepos.map((r) => ({ value: r.cloneUrl, label: r.fullName }))}
                          />
                        </Field>
                      ) : (
                        <Field label={t("apps.gitUrl")} style={{ gridColumn: "1 / -1" }}>
                          <TextInput value={gitUrl} onChange={(e) => setGitUrl(e.target.value)} required />
                        </Field>
                      )}
                      <Field label={t("apps.branch")}>
                        <TextInput value={gitBranch} onChange={(e) => setGitBranch(e.target.value)} placeholder="main" />
                      </Field>
                      <Field label={t("apps.buildType")}>
                        <Select value={buildType} onChange={(v) => setBuildType(v as "NIXPACKS" | "DOCKERFILE" | "STATIC" | "RAILPACK" | "HEROKU")}
                          options={[
                            { value: "NIXPACKS", label: t("apps.nixpacks") },
                            { value: "RAILPACK", label: t("apps.railpack") },
                            { value: "HEROKU", label: t("apps.heroku") },
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
                  {sel.group === "db" && (() => {
                    const versions = engineVersions(sel.engine);
                    const isCustom = !versions.includes(version);
                    return (
                      <>
                        <Field label={t("databases.engine")}>
                          <TextInput value={engineLabel(sel.engine)} disabled />
                        </Field>
                        <Field label={t("databases.version")} hint={t("databases.versionHint")}>
                          <Select
                            value={isCustom ? "__custom__" : version}
                            onChange={(v) => setVersion(v === "__custom__" ? "" : v)}
                            options={[
                              ...versions.map((v) => ({ value: v, label: v })),
                              { value: "__custom__", label: t("databases.versionCustom") },
                            ]}
                          />
                        </Field>
                        {isCustom && (
                          <Field label={t("databases.versionCustomLabel")}>
                            <TextInput value={version} onChange={(e) => setVersion(e.target.value)} placeholder="e.g. 16-alpine" />
                          </Field>
                        )}
                        <Field label={t("databases.hostPort")} hint={t("databases.hostPortHint")}>
                          <TextInput type="number" value={hostPort} onChange={(e) => setHostPort(e.target.value)} />
                        </Field>
                      </>
                    );
                  })()}
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
    <Suspense fallback={<div style={{ padding: "var(--page-pad)" }}><Spinner /></div>}>
      <Wizard />
    </Suspense>
  );
}
