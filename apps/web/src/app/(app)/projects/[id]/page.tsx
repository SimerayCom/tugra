"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Box, Database, Layers, Plus, Pencil, FolderTree, CloudUpload, Trash2, type LucideIcon } from "lucide-react";
import { api, appIconUrl, projectIconUrl } from "../../../../lib/api";
import { cropToPngBase64 } from "../../../../lib/icon";
import { useToast } from "../../../../components/toast";
import { ErrorState } from "../../../../components/error-state";
import { RenameModal } from "../../../../components/rename-modal";
import { AppLogo } from "../../../../components/app-logo";
import type { AppSource, AppStatus, DbStatus, Environment, ProjectResource } from "../../../../lib/types";
import { appColor } from "../../../../lib/apps";
import { dbColor } from "../../../../lib/databases";
import { TemplateLogo, ENGINE_LOGO } from "../../../../lib/template-icons";
import { useT } from "../../../../i18n/provider";
import { Badge, Btn, Card, StatusPill } from "../../../../components/ui";
import { Skeleton, SkeletonCard } from "../../../../components/skeleton";
import { PageHeader } from "../../../../components/page-header";
import { TagChips } from "../../../../components/tags";
import { useConfirm } from "../../../../components/confirm";

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
  const confirm = useConfirm();

  const { data: project, isLoading, isError, refetch } = useQuery({ queryKey: ["project", id], queryFn: () => api.getProject(id) });
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
  const [renaming, setRenaming] = useState(false);
  const [rname, setRname] = useState("");
  const rename = useMutation({
    mutationFn: () => api.renameProject(id, rname.trim()),
    onSuccess: () => { setRenaming(false); invalidate(); qc.invalidateQueries({ queryKey: ["projects"] }); },
  });

  if (isError && !project) return <div style={{ padding: "var(--page-pad)" }}><ErrorState onRetry={() => refetch()} /></div>;
  if (isLoading || !project) return <ProjectDetailSkeleton />;
  const empty = project.environments.every((e) => e.appCount + e.dbCount === 0);

  return (
    <div style={{ padding: "var(--page-pad)" }}>
      <PageHeader
        breadcrumb={[{ label: t("nav.projects"), href: "/projects" }, { label: project.name }]}
        title={project.name}
        actions={
          project.canWrite ? (
            <div style={{ display: "flex", gap: 8 }}>
              <Btn variant="ghost" onClick={() => { setRname(project.name); setRenaming(true); }}>{t("projects.rename")}</Btn>
              {empty && (
                <Btn variant="danger" onClick={async () => { if (await confirm({ title: t("projects.deleteProject"), body: t("projects.deleteConfirm"), danger: true, confirmText: project.name })) del.mutate(); }}>{t("projects.deleteProject")}</Btn>
              )}
            </div>
          ) : undefined
        }
      />

      <ProjectIconCard id={id} name={project.name} iconUpdatedAt={project.iconUpdatedAt} canWrite={project.canWrite} onChanged={() => { invalidate(); qc.invalidateQueries({ queryKey: ["projects"] }); }} />

      {renaming && (
        <Card style={{ padding: 12, marginBottom: 12 }}>
          <form onSubmit={(e) => { e.preventDefault(); if (rname.trim()) rename.mutate(); }} style={{ display: "flex", gap: 8 }}>
            <input style={{ ...field, flex: 1 }} value={rname} onChange={(e) => setRname(e.target.value)} autoFocus required />
            <Btn type="submit" disabled={rename.isPending || !rname.trim()}>{rename.isPending ? "…" : t("common.save")}</Btn>
            <Btn variant="ghost" onClick={() => setRenaming(false)}>{t("common.cancel")}</Btn>
          </form>
          {rename.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(rename.error as Error).message}</div>}
        </Card>
      )}

      <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 12 }}>{t("projects.environments")}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {project.environments.map((env) => (
          <EnvironmentBlock key={env.id} env={env} projectId={id} canWrite={project.canWrite} onChange={invalidate} />
        ))}
      </div>

      {project.canWrite && (
        <Card style={{ padding: 16, marginTop: 16 }}>
          <form onSubmit={(e) => { e.preventDefault(); addEnv.mutate(); }} style={{ display: "flex", gap: 8 }}>
            <input style={{ ...field, flex: 1 }} placeholder={t("projects.environmentName")} aria-label={t("projects.environmentName")} value={envName} onChange={(e) => setEnvName(e.target.value)} required />
            <Btn onClick={() => addEnv.mutate()} disabled={addEnv.isPending || !envName}>{t("projects.addEnvironment")}</Btn>
          </form>
        </Card>
      )}
    </div>
  );
}

/** A project's custom icon: a square PNG uploaded by the operator (write-gated), shown with a folder
 *  fallback. Mirrors the app icon card — the browser center-crops to a small PNG before upload, shrinking
 *  it until it fits the server's 64KB cap. */
function ProjectIconCard({ id, name, iconUpdatedAt, canWrite, onChanged }: { id: string; name: string; iconUpdatedAt: string | null; canWrite: boolean; onChanged: () => void }) {
  const t = useT();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [processing, setProcessing] = useState(false);
  const url = projectIconUrl(id, iconUpdatedAt);

  const save = useMutation({
    mutationFn: (data: string) => api.setProjectIcon(id, data),
    onSuccess: () => { onChanged(); toast(t("projects.iconUploaded"), "success"); },
    onError: (e) => toast(e instanceof Error && e.message ? e.message : t("projects.iconFailed"), "error"),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteProjectIcon(id),
    onSuccess: () => { onChanged(); toast(t("projects.iconRemoved"), "success"); },
    onError: (e) => toast(e instanceof Error && e.message ? e.message : t("projects.iconFailed"), "error"),
  });

  const onPick = async (file: File) => {
    setProcessing(true);
    try {
      let data = "";
      for (const side of [128, 96, 64]) {
        data = await cropToPngBase64(file, side);
        if (data.length * 0.75 <= 64 * 1024) break;
      }
      if (data.length * 0.75 > 64 * 1024) { toast(t("projects.iconTooLarge"), "error"); return; }
      save.mutate(data);
    } catch {
      toast(t("projects.iconReadFailed"), "error");
    } finally {
      setProcessing(false);
    }
  };

  const busy = processing || save.isPending || remove.isPending;
  return (
    <Card style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <span style={{ width: 48, height: 48, borderRadius: 12, background: "var(--c-el)", border: "1px solid var(--c-bd)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, overflow: "hidden" }}>
          {url ? <img src={url} alt="" width={48} height={48} style={{ objectFit: "cover" }} /> : <FolderTree size={22} color="var(--c-tx3)" />}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>{name}</div>
          <div style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("projects.iconHint")}</div>
        </div>
        {canWrite && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Btn variant="ghost" icon={CloudUpload} onClick={() => fileRef.current?.click()} disabled={busy}>
              {busy ? "…" : url ? t("projects.iconReplace") : t("projects.iconUpload")}
            </Btn>
            {url && <Btn variant="ghost" icon={Trash2} onClick={() => remove.mutate()} disabled={busy}>{t("projects.iconRemove")}</Btn>}
          </div>
        )}
      </div>
      <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" style={{ display: "none" }}
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void onPick(f); }} />
    </Card>
  );
}

/** Page-shaped shimmer shown while the project query is loading — mirrors the header, the
 * environments label, and each environment card (name/badges + Applications/Databases
 * resource grids) so the skeleton→content swap doesn't jump. */
function ProjectDetailSkeleton() {
  return (
    <div style={{ padding: "var(--page-pad)" }}>
      <div style={{ marginBottom: 20 }}>
        <Skeleton height={11} width={90} style={{ marginBottom: 10 }} />
        <Skeleton height={24} width={220} />
      </div>

      <Skeleton height={11} width={110} style={{ marginBottom: 12 }} />
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {Array.from({ length: 2 }).map((_, i) => (
          <SkeletonCard key={i}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
              <Skeleton height={14} width={110} />
              <Skeleton height={20} width={62} />
              <Skeleton height={20} width={58} />
            </div>
            <SkeletonResourceGroup />
            <SkeletonResourceGroup />
          </SkeletonCard>
        ))}
      </div>
    </div>
  );
}

/** One resource-group placeholder — a label plus a grid of resource-tile shimmers, matching
 * ResourceGroup's own grid (gridTemplateColumns: repeat(auto-fill, minmax(300px, 1fr))). */
function SkeletonResourceGroup() {
  return (
    <div style={{ marginBottom: 12 }}>
      <Skeleton height={11} width={90} style={{ marginBottom: 8 }} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 8 }}>
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)" }}>
            <Skeleton width={36} height={36} radius={8} style={{ flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <Skeleton height={13} width="55%" style={{ marginBottom: 6 }} />
              <Skeleton height={11} width="35%" />
            </div>
          </div>
        ))}
      </div>
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
  const apps = all.filter((r) => r.kind === "app" && r.source !== "COMPOSE" && match(r));
  const services = all.filter((r) => r.kind === "app" && r.source === "COMPOSE" && match(r));
  const dbs = all.filter((r) => r.kind === "database" && match(r));
  const remove = useMutation({ mutationFn: () => api.deleteEnvironment(env.id), onSuccess: onChange });
  const [renaming, setRenaming] = useState(false);
  const rename = useMutation({ mutationFn: (name: string) => api.renameEnvironment(env.id, name), onSuccess: () => { onChange(); setRenaming(false); } });
  const newHref = (kind: "app" | "service" | "database") => `/resources/new?project=${projectId}&env=${env.id}&kind=${kind}`;
  const chip: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, fontWeight: 600, color: "var(--c-a)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: "3px 10px", textDecoration: "none" };
  return (
    <Card style={{ padding: 16 }}>
      {renaming && <RenameModal current={env.name} title={t("projects.renameEnvironment")} onClose={() => setRenaming(false)} onSave={(n) => rename.mutate(n)} pending={rename.isPending} />}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
        <span style={{ fontWeight: 600, fontSize: 14 }}>{env.name}</span>
        {canWrite && <button onClick={() => setRenaming(true)} title={t("projects.renameEnvironment")} aria-label={t("projects.renameEnvironment")} style={{ background: "transparent", border: "none", color: "var(--c-tx3)", cursor: "pointer", display: "inline-flex", padding: 2 }}><Pencil size={13} /></button>}
        <Badge>{env.appCount} apps</Badge>
        <Badge>{env.dbCount} dbs</Badge>
        <div style={{ flex: 1 }} />
        {canWrite && (
          <>
            <Link href={newHref("app")} style={chip}><Plus size={13} /> {t("projects.newApp")}</Link>
            <Link href={newHref("service")} style={chip}><Plus size={13} /> {t("projects.newService")}</Link>
            <Link href={newHref("database")} style={chip}><Plus size={13} /> {t("projects.newDatabase")}</Link>
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
          placeholder={t("projects.searchResources")} aria-label={t("projects.searchResources")}
          style={{ width: "100%", boxSizing: "border-box", padding: "7px 10px", marginBottom: 12, background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", color: "var(--c-tx)", fontSize: 13, fontFamily: "inherit" }}
        />
      )}
      {empty && <div style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("projects.noResources")}</div>}
      <ResourceGroup title={t("projects.applications")} items={apps} icon={Box} />
      <ResourceGroup title={t("projects.services")} items={services} icon={Layers} />
      <ResourceGroup title={t("projects.databases")} items={dbs} icon={Database} />
    </Card>
  );
}

function ResourceGroup({ title, items, icon: Icon }: { title: string; items: ProjectResource[]; icon: LucideIcon }) {
  if (!items.length) return null;
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--c-tx3)", textTransform: "uppercase", letterSpacing: "0.05em", margin: "4px 0 6px" }}>{title}</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 8 }}>
        {items.map((r) => {
          const color = r.kind === "app" ? appColor(r.status as AppStatus) : dbColor(r.status as DbStatus);
          return (
            <Link
              key={`${r.kind}:${r.id}`}
              href={r.kind === "app" ? `/apps/${r.id}` : `/databases/${r.id}`}
              style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: "var(--c-tx)", textDecoration: "none", padding: "10px 12px", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", background: "var(--c-el)" }}
            >
              <span style={{ width: 36, height: 36, borderRadius: 8, background: "var(--c-tile)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                {r.kind === "app" ? (
                  // Same icon as the app list/detail: custom upload → catalog brand logo → source icon.
                  <AppLogo iconUrl={appIconUrl(r.id, r.iconUpdatedAt)} templateSlug={r.templateSlug} templateLogo={r.templateLogo} source={(r.source ?? "IMAGE") as AppSource} name={r.name} size={22} />
                ) : r.engine && ENGINE_LOGO[r.engine] ? (
                  <TemplateLogo logo={ENGINE_LOGO[r.engine]} slug={r.engine} name={r.engine} size={22} />
                ) : (
                  <Icon size={18} color="var(--c-a)" />
                )}
              </span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</span>
                  <TagChips tags={r.tags} />
                </div>
                <div className="mono" style={{ fontSize: 11, color: "var(--c-tx3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {r.url ? r.url : r.engine ?? ""}
                  {r.serverName ? ` · ${r.serverName}` : ""}
                </div>
              </div>
              <StatusPill label={r.status} color={color} />
            </Link>
          );
        })}
      </div>
    </div>
  );
}
