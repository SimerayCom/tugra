"use client";

import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import type { Template } from "../../../lib/types";
import { appColor, appSourceSummary } from "../../../lib/apps";
import { useT } from "../../../i18n/provider";
import { Btn, Card, Spinner } from "../../../components/ui";
import { TagChips, TagFilter } from "../../../components/tags";
import { templateIcon } from "../../../lib/template-icons";

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

  return (
    <div style={{ padding: 28 }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 22 }}>
        <div style={{ flex: 1 }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 4px" }}>{t("apps.title")}</h1>
          <p style={{ color: "var(--c-tx3)", fontSize: 14, margin: 0 }}>{t("apps.subtitle")}</p>
        </div>
        <Link href="/resources/new?kind=app" style={{ background: "var(--c-a)", color: "#0d0d11", fontWeight: 600, fontSize: 13, padding: "9px 14px", borderRadius: "var(--r1)", textDecoration: "none" }}>
          {t("apps.newApp")}
        </Link>
      </div>

      {templates.length > 0 && (
        <TemplateGallery templates={templates} serverId={servers[0]?.id} />
      )}

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
        {templates.map((tpl) => {
          const Icon = templateIcon(tpl.slug);
          return (
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
              <Icon size={18} />
              {tpl.name}
            </button>
          );
        })}
      </div>
      {picked && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12 }}>
          {(() => { const Icon = templateIcon(picked.slug); return <Icon size={18} />; })()}
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
