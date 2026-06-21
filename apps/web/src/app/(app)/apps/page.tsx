"use client";

import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import type { Template } from "../../../lib/types";
import { appColor, appSourceSummary } from "../../../lib/apps";
import { useT } from "../../../i18n/provider";
import { Btn, Card, Spinner } from "../../../components/ui";
import { Select } from "../../../components/form";
import { TagChips, TagFilter } from "../../../components/tags";

const field: React.CSSProperties = {
  padding: "8px 10px",
  background: "var(--c-el)",
  border: "1px solid var(--c-bd)",
  borderRadius: "var(--r1)",
  color: "var(--c-tx)",
  fontSize: 13,
  fontFamily: "inherit",
};

export default function AppsPage() {
  const t = useT();
  const qc = useQueryClient();
  const { data: apps = [], isLoading } = useQuery({
    queryKey: ["apps"],
    queryFn: () => api.listApps(),
    refetchInterval: 8000,
  });
  const { data: servers = [] } = useQuery({ queryKey: ["servers"], queryFn: () => api.listServers() });
  const { data: templates = [] } = useQuery({ queryKey: ["templates"], queryFn: () => api.listTemplates() });

  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const allTags = [...new Set(apps.flatMap((a) => a.tags))].sort();
  const visibleApps = apps.filter((a) => selectedTags.every((tag) => a.tags.includes(tag)));
  const noServer = servers.length === 0;

  const [name, setName] = useState("");
  const [serverId, setServerId] = useState("");
  const [source, setSource] = useState<"IMAGE" | "GIT" | "COMPOSE">("IMAGE");
  const [image, setImage] = useState("");
  const [gitUrl, setGitUrl] = useState("");
  const [gitBranch, setGitBranch] = useState("");
  const [buildType, setBuildType] = useState<"NIXPACKS" | "DOCKERFILE" | "STATIC">("NIXPACKS");
  const [buildCommand, setBuildCommand] = useState("");
  const [outputDir, setOutputDir] = useState("");
  const [composeFile, setComposeFile] = useState("");
  const [hostPort, setHostPort] = useState("");
  const [domain, setDomain] = useState("");

  const create = useMutation({
    mutationFn: () =>
      api.createApp({
        name,
        serverId: serverId || servers[0]?.id,
        source,
        image: source === "IMAGE" ? image : undefined,
        gitUrl: source === "GIT" ? gitUrl : undefined,
        gitBranch: source === "GIT" ? gitBranch || undefined : undefined,
        buildType: source === "GIT" ? buildType : undefined,
        buildCommand: source === "GIT" && buildType === "STATIC" ? buildCommand || undefined : undefined,
        outputDir: source === "GIT" && buildType === "STATIC" ? outputDir || undefined : undefined,
        composeFile: source === "COMPOSE" ? composeFile : undefined,
        hostPort: hostPort ? Number(hostPort) : undefined,
        domain: domain || undefined,
      }),
    onSuccess: () => {
      setName("");
      setImage("");
      setGitUrl("");
      setGitBranch("");
      setComposeFile("");
      setHostPort("");
      setDomain("");
      qc.invalidateQueries({ queryKey: ["apps"] });
    },
  });

  return (
    <div style={{ padding: 28 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 4px" }}>{t("apps.title")}</h1>
      <p style={{ color: "var(--c-tx3)", fontSize: 14, margin: "0 0 22px" }}>{t("apps.subtitle")}</p>

      {templates.length > 0 && (
        <TemplateGallery templates={templates} serverId={serverId || servers[0]?.id} />
      )}

      <Card style={{ padding: 16, marginBottom: 20 }}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
          style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}
        >
          <input style={{ ...field, flex: 1, minWidth: 110 }} placeholder={t("apps.name")} value={name} onChange={(e) => setName(e.target.value)} required />
          <Select value={serverId} onChange={setServerId} autoSelectFirst required placeholder={t("apps.server")}
            style={{ width: "auto", minWidth: 130 }}
            options={servers.map((s) => ({ value: s.id, label: s.name }))} />
          <select style={field} value={source} onChange={(e) => setSource(e.target.value as "IMAGE" | "GIT" | "COMPOSE")}>
            <option value="IMAGE">{t("apps.sourceImage")}</option>
            <option value="GIT">{t("apps.sourceGit")}</option>
            <option value="COMPOSE">{t("apps.sourceCompose")}</option>
          </select>
          {source === "IMAGE" && (
            <input style={{ ...field, flex: 2, minWidth: 160 }} placeholder={t("apps.image")} value={image} onChange={(e) => setImage(e.target.value)} required />
          )}
          {source === "GIT" && (
            <>
              <input style={{ ...field, flex: 2, minWidth: 160 }} placeholder={t("apps.gitUrl")} value={gitUrl} onChange={(e) => setGitUrl(e.target.value)} required />
              <input style={{ ...field, width: 110 }} placeholder={t("apps.branch")} value={gitBranch} onChange={(e) => setGitBranch(e.target.value)} />
              <select style={field} value={buildType} onChange={(e) => setBuildType(e.target.value as "NIXPACKS" | "DOCKERFILE" | "STATIC")}>
                <option value="NIXPACKS">{t("apps.nixpacks")}</option>
                <option value="DOCKERFILE">{t("apps.dockerfile")}</option>
                <option value="STATIC">{t("apps.static")}</option>
              </select>
              {buildType === "STATIC" && (
                <>
                  <input style={{ ...field, width: 180 }} placeholder={t("apps.buildCommand")} value={buildCommand} onChange={(e) => setBuildCommand(e.target.value)} />
                  <input style={{ ...field, width: 120 }} placeholder={t("apps.outputDir")} value={outputDir} onChange={(e) => setOutputDir(e.target.value)} />
                </>
              )}
            </>
          )}
          {source !== "COMPOSE" && (
            <>
              <input style={{ ...field, width: 130 }} placeholder={t("apps.hostPort")} value={hostPort} onChange={(e) => setHostPort(e.target.value)} type="number" />
              <input style={{ ...field, flex: 1, minWidth: 150 }} placeholder={t("apps.domain")} value={domain} onChange={(e) => setDomain(e.target.value)} />
            </>
          )}
          {source === "COMPOSE" && (
            <textarea
              style={{ ...field, flex: "1 1 100%", minHeight: 120, fontFamily: "var(--font-mono, monospace)", resize: "vertical" }}
              placeholder={t("apps.composeFile")}
              value={composeFile}
              onChange={(e) => setComposeFile(e.target.value)}
              required
            />
          )}
          <button type="submit" disabled={create.isPending || noServer} style={{ ...field, background: "var(--c-a)", color: "#0d0d11", fontWeight: 600, cursor: noServer ? "not-allowed" : "pointer", opacity: noServer ? 0.5 : 1 }}>
            {create.isPending ? "…" : t("apps.create")}
          </button>
        </form>
        {noServer && (
          <div style={{ fontSize: 12, color: "var(--c-tx3)", marginTop: 10 }}>
            {t("apps.needServer")} <Link href="/servers/new" style={{ color: "var(--c-a)" }}>{t("apps.addServer")}</Link>
          </div>
        )}
        {create.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(create.error as Error).message}</div>}
      </Card>

      {isLoading ? (
        <Spinner />
      ) : (
        <>
          <TagFilter all={allTags} selected={selectedTags} onChange={setSelectedTags} />
          <div style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r2)", overflow: "hidden" }}>
            {visibleApps.map((a) => (
              <Link key={a.id} href={`/apps/${a.id}`} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderTop: "1px solid var(--c-bd)", textDecoration: "none", color: "var(--c-tx)" }}>
                <span style={{ width: 9, height: 9, borderRadius: "50%", background: appColor(a.status) }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 14, display: "flex", alignItems: "center", gap: 8 }}>
                    {a.name}
                    <TagChips tags={a.tags} />
                  </div>
                  <div className="mono" style={{ fontSize: 11, color: "var(--c-tx3)" }}>{appSourceSummary(a)}</div>
                </div>
                <span style={{ fontSize: 12, color: appColor(a.status), fontWeight: 600 }}>{a.status}</span>
              </Link>
            ))}
            {visibleApps.length === 0 && (
              <div style={{ padding: 32, textAlign: "center", color: "var(--c-tx3)", fontSize: 13 }}>{t("apps.empty")}</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function TemplateGallery({ templates, serverId }: { templates: Template[]; serverId?: string }) {
  const t = useT();
  const qc = useQueryClient();
  const [picked, setPicked] = useState<Template | null>(null);
  const [name, setName] = useState("");
  const deploy = useMutation({
    mutationFn: () => api.createFromTemplate(picked!.slug, { name, serverId: serverId! }),
    onSuccess: () => {
      setPicked(null);
      setName("");
      qc.invalidateQueries({ queryKey: ["apps"] });
    },
  });

  return (
    <Card style={{ padding: 16, marginBottom: 20 }}>
      <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 4 }}>{t("templates.gallery")}</div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>{t("templates.galleryDesc")}</p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {templates.map((tpl) => (
          <button
            key={tpl.slug}
            onClick={() => { setPicked(tpl); setName(tpl.slug); }}
            title={tpl.description}
            style={{
              display: "flex", alignItems: "center", gap: 8, padding: "8px 12px",
              background: picked?.slug === tpl.slug ? "var(--c-el)" : "transparent",
              border: "1px solid var(--c-bd)", borderRadius: "var(--r1)",
              color: "var(--c-tx)", cursor: "pointer", fontFamily: "inherit", fontSize: 13,
            }}
          >
            <span style={{ fontSize: 18 }}>{tpl.icon}</span>
            {tpl.name}
          </button>
        ))}
      </div>
      {picked && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12 }}>
          <span style={{ fontSize: 18 }}>{picked.icon}</span>
          <input
            autoFocus
            style={{ ...field, flex: 1, minWidth: 140 }}
            placeholder={t("templates.namePlaceholder")}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Btn onClick={() => deploy.mutate()} disabled={deploy.isPending || !name || !serverId}>
            {deploy.isPending ? t("templates.deploying") : t("templates.deploy")}
          </Btn>
          <Btn variant="ghost" onClick={() => setPicked(null)}>{t("templates.cancel")}</Btn>
        </div>
      )}
      {deploy.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(deploy.error as Error).message}</div>}
    </Card>
  );
}
