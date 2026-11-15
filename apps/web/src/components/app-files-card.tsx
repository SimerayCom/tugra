"use client";

import { useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import Link from "next/link";
import { useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { Folder, File as FileIcon, Link2, ChevronRight, HardDrive, Upload, FilePlus, FolderPlus, RefreshCw } from "lucide-react";
import { api, ApiError } from "../lib/api";
import type { AppVolume, FileEntry } from "../lib/types";
import { fmtBytes } from "../lib/fleet";
import { FS_PART_PREFIX, joinPath, pathSegments, pathUpTo } from "../lib/file-utils";
import { downloadHref, filesApi, fsErrorKey, type FsScope, type FsTarget } from "../lib/files-api";
import { useT } from "../i18n/provider";
import { Spinner, EmptyState, Badge, Btn } from "./ui";
import { Menu, type MenuItem } from "./menu";
import { Select, TextInput } from "./form";
import { AppFileEditor } from "./app-file-editor";
import { ChmodDialog, DatastoreAckDialog, DeleteConfirmDialog, NewEntryDialog, OverwriteDialog, RenameDialog } from "./app-file-dialogs";
import { UploadQueuePanel, useUploadQueue } from "./app-file-uploads";

type Dialog =
  | { kind: "new"; type: "file" | "folder" }
  | { kind: "rename"; entry: FileEntry }
  | { kind: "chmod"; entry: FileEntry; mode: string }
  | { kind: "delete"; entry: FileEntry; notEmpty?: boolean }
  | { kind: "edit"; name: string; isNew: boolean };

/**
 * File manager for one app's declared volumes (and, for terminal-capable users, its live container filesystem).
 * Shared by the fleet app-detail "Files" tab and the Home launcher's inline files view.
 *
 * READ side (always): list metadata, navigate directories, symlinks shown but never followed.
 * WRITE side (only when `canWrite` AND the hub's file meta says this volume is writable): upload (multi-select,
 * drag-and-drop, 3 parallel, progress, cancel/retry), new file/folder, edit (text, <= 1 MiB), download, rename,
 * permissions and delete. Without `canWrite` — or when meta can't be loaded — it behaves as the read-only browser.
 */
export function AppFilesCard({
  id,
  volumes,
  canWrite = false,
  serverId,
}: {
  id: string;
  volumes: AppVolume[];
  canWrite?: boolean;
  /** For the "open server capabilities" link in the state panels. */
  serverId?: string;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [source, setSource] = useState<FsScope>("volume");
  const [volume, setVolume] = useState(volumes[0]?.name ?? "");
  const [vpath, setVpath] = useState("");
  const [cpath, setCpath] = useState("/app");
  const [pathDraft, setPathDraft] = useState("/app");
  const [pickedContainer, setPickedContainer] = useState("");
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | undefined>();
  const [actionError, setActionError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [ackAsk, setAckAsk] = useState<{ resolve: (ok: boolean) => void } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // After a navigation we move keyboard focus to the active breadcrumb crumb, so keyboard/SR users don't
  // get dropped to <body> when the list re-renders. Guarded so we don't steal focus on first mount.
  const navigatedRef = useRef(false);
  const activeCrumbRef = useRef<HTMLButtonElement>(null);

  const meta = useQuery({
    queryKey: ["app", id, "filesMeta"],
    queryFn: () => filesApi.filesMeta(id),
    enabled: canWrite,
    retry: false,
    staleTime: 10_000,
  });
  const m = meta.data;

  // An app with no declared volumes can still be browsed through its container filesystem.
  const scope: FsScope = source === "volume" && volumes.length === 0 && m?.container.available ? "container" : source;
  const path = scope === "volume" ? vpath : cpath;
  const setPath = scope === "volume" ? setVpath : setCpath;

  // Container name: the single container of a plain app comes from meta; a COMPOSE app picks from its containers.
  const needsPicker = scope === "container" && !!m && m.container.names.length === 0;
  const containers = useQuery({
    queryKey: ["appContainers", id],
    queryFn: () => api.listAppContainers(id),
    enabled: needsPicker,
  });
  const containerList = containers.data?.containers ?? [];
  const containerName = scope === "container" ? (m?.container.names[0] ?? (pickedContainer || containerList[0]?.name || "")) : "";
  const target: FsTarget = { scope, name: scope === "volume" ? volume : containerName };

  const q = useQuery({
    queryKey: scope === "volume" ? ["app", id, "files", volume, vpath] : ["app", id, "container-files", containerName, cpath],
    queryFn: () => (scope === "volume" ? api.listAppFiles(id, volume, vpath) : filesApi.listContainerFiles(id, containerName, cpath)),
    enabled: scope === "volume" ? !!volume : !!containerName,
    // Keep the current list mounted while the next folder loads — no spinner flash, no focus loss.
    placeholderData: keepPreviousData,
  });

  useEffect(() => {
    if (navigatedRef.current) {
      navigatedRef.current = false;
      activeCrumbRef.current?.focus();
    }
  }, [volume, vpath, cpath, source]);

  // ── capability / state derivation (all from the hub's meta) ──────────────────────────────────────────────
  const volumeMeta = m?.volumes.find((v) => v.name === volume);
  const writable = canWrite && !!m && (scope === "volume" ? !!volumeMeta?.writable : m.container.writable);
  const limits = m?.limits;
  const refreshList = () => {
    void qc.invalidateQueries({ queryKey: ["app", id, "files"] });
    void qc.invalidateQueries({ queryKey: ["app", id, "container-files"] });
  };

  const describeError = (e: unknown): string => {
    const k = fsErrorKey(e);
    return k ? t(k) : e instanceof Error ? e.message : t("apps.files.actionFailed");
  };

  const uploads = useUploadQueue({
    id,
    maxBytes: limits?.maxUploadBytes ?? 0,
    describeError,
    tooLargeText: (max) => t("apps.files.queueTooLarge", { max: fmtBytes(max) }),
    onChanged: refreshList,
  });

  const requestAck = () => new Promise<boolean>((resolve) => setAckAsk({ resolve }));
  /** Run a mutation; a 409 datastore_running asks for the acknowledgement and retries once with it. */
  async function mutate(fn: (ack: boolean) => Promise<unknown>): Promise<void> {
    try {
      await fn(false);
    } catch (e) {
      if (e instanceof ApiError && e.code === "datastore_running" && scope === "volume" && (await requestAck())) {
        await fn(true);
        return;
      }
      throw e;
    }
  }

  if (volumes.length === 0 && scope === "volume") {
    return (
      <EmptyState icon={HardDrive} title={t("apps.files.noVolumesTitle")}>
        {t("apps.files.noVolumes")}
      </EmptyState>
    );
  }

  const segments = pathSegments(scope, path);
  const go = (p: string) => {
    navigatedRef.current = true;
    setPath(p);
    if (scope === "container") setPathDraft(p);
  };
  const openVolume = (name: string) => {
    if (name === volume && scope === "volume") return;
    navigatedRef.current = true;
    setSource("volume");
    setVolume(name);
    setVpath("");
  };
  const switchSource = (s: FsScope) => {
    if (s === scope) return;
    navigatedRef.current = true;
    setSource(s);
    setActionError(null);
  };

  // Directories first, then alphabetical — a conventional file-manager order. The helper's temp files are hidden.
  const entries = q.data
    ? [...q.data.entries]
        .filter((e) => !e.name.startsWith(FS_PART_PREFIX))
        .sort((a, b) => (a.type === "dir" ? 0 : 1) - (b.type === "dir" ? 0 : 1) || a.name.localeCompare(b.name))
    : [];
  const firstLoad = q.isPending && !q.data && (scope === "volume" ? !!volume : !!containerName);
  const pathOf = (name: string) => joinPath(scope, path, name);

  // ── actions ──────────────────────────────────────────────────────────────────────────────────────────────
  const closeDialog = () => {
    setDialog(null);
    setBusy(false);
    setDialogError(undefined);
  };
  const runDialog = async (fn: () => Promise<unknown>, onNotEmpty?: () => void) => {
    setBusy(true);
    setDialogError(undefined);
    try {
      await fn();
      closeDialog();
      refreshList();
    } catch (e) {
      setBusy(false);
      if (onNotEmpty && e instanceof ApiError && e.code === "not_empty") return onNotEmpty();
      if (e instanceof ApiError && e.code === "datastore_running") return; // declined acknowledgement: stay open
      setDialogError(describeError(e));
    }
  };

  const startDownload = (entry: FileEntry) => {
    const a = document.createElement("a");
    a.href = downloadHref(id, target, pathOf(entry.name));
    a.download = entry.name;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const openChmod = async (entry: FileEntry) => {
    setActionError(null);
    try {
      const st = await filesApi.statFile(id, target, pathOf(entry.name));
      setDialog({ kind: "chmod", entry, mode: st.mode });
    } catch (e) {
      setActionError(describeError(e));
    }
  };

  const menuFor = (entry: FileEntry): MenuItem[] => {
    const items: MenuItem[] = [];
    const canDownload = canWrite && !!m && (scope === "volume" ? m.capabilities.files : m.container.available);
    if (entry.type === "file") {
      if (writable && entry.size <= (limits?.maxEditBytes ?? 0)) items.push({ key: "edit", label: t("apps.files.edit"), onSelect: () => setDialog({ kind: "edit", name: entry.name, isNew: false }) });
      if (canDownload) items.push({ key: "download", label: t("apps.files.download"), onSelect: () => startDownload(entry) });
    }
    if (writable) {
      items.push({ key: "rename", label: t("apps.files.rename"), onSelect: () => setDialog({ kind: "rename", entry }) });
      if (entry.type === "file" || entry.type === "dir") items.push({ key: "chmod", label: t("apps.files.permissions"), onSelect: () => void openChmod(entry) });
      items.push({ key: "delete", label: t("apps.files.delete"), danger: true, onSelect: () => setDialog({ kind: "delete", entry }) });
    }
    return items;
  };

  // A file dragged onto the list must never fall through to the browser (which would navigate away and open it), so
  // every file drag is cancelled here; only a writable volume shows the overlay and queues uploads.
  const isFileDrag = (e: DragEvent<HTMLDivElement>) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
  const onDrag = (e: DragEvent<HTMLDivElement>, on: boolean) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    if (writable) setDragging(on);
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    setDragging(false);
    if (!writable) return;
    const list = Array.from(e.dataTransfer?.files ?? []);
    if (list.length > 0) uploads.add(list, target, pathOf);
  };

  // ── notes from meta ──────────────────────────────────────────────────────────────────────────────────────
  const notes: ReactNode[] = [];
  const serverLink = serverId ? (
    <Link href={`/servers/${serverId}`} style={{ color: "var(--c-lapis)", fontWeight: 600, marginLeft: 6 }}>{t("apps.files.capOffLink")}</Link>
  ) : null;
  if (canWrite && m) {
    if (!m.capabilities.files) notes.push(<Note key="capOff" tone="warn">{t("apps.files.capOff")}{serverLink}</Note>);
    else if (!m.capabilities.filesWrite) notes.push(<Note key="writeCapOff" tone="info"><strong>{t("apps.files.writeCapOff")}</strong> {t("apps.files.writeCapHint")}{serverLink}</Note>);
    else if (!m.agentSupportsFs2) notes.push(<Note key="agentOld" tone="warn">{t("apps.files.agentOld")}</Note>);
    else if (!m.serverOnline) notes.push(<Note key="offline" tone="warn">{t("apps.files.offline")}</Note>);
    if (scope === "volume" && volumeMeta?.reason === "deploy_in_progress") notes.push(<Note key="deploy" tone="info">{t("apps.files.deployInProgress")}</Note>);
    if (scope === "container" && m.container.reason === "deploy_in_progress") notes.push(<Note key="cdeploy" tone="info">{t("apps.files.deployInProgress")}</Note>);
    if (scope === "volume" && volumeMeta?.reason === "datastore_running") notes.push(<Note key="datastore" tone="warn">{t("apps.files.datastoreWarn")}</Note>);
    if (scope === "volume" && !m.container.available) {
      const r = m.container.reason;
      if (r === "clustered") notes.push(<Note key="clustered" tone="muted">{t("apps.files.clustered")}</Note>);
      else if (r === "not_deployed") notes.push(<Note key="notDeployed" tone="muted">{t("apps.files.notDeployed")}</Note>);
      else if (r === "permission") notes.push(<Note key="termPerm" tone="muted">{t("apps.files.terminalPermOff")}</Note>);
      else if (r === "capability" && m.capabilities.files) notes.push(<Note key="termCap" tone="muted">{t("apps.files.terminalCapOff")}</Note>);
    }
    if (scope === "container") {
      notes.push(<Note key="ephemeral" tone="warn">{t("apps.files.containerEphemeral")}</Note>);
      if (writable) notes.push(<Note key="nobin" tone="muted">{t("apps.files.containerNoBinary")}</Note>);
    }
  }

  const sourceSwitch = canWrite && m?.container.available;
  const dirOfEntry = path;

  return (
    <div>
      {/* Source switcher: declared volumes vs the live container filesystem (terminal-capable users only). */}
      {sourceSwitch && (
        <div role="group" aria-label={t("apps.files.sourceLabel")} style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
          {(["volume", "container"] as const).map((s) => (
            <ChipButton key={s} pressed={scope === s} onClick={() => switchSource(s)}>
              {t(s === "volume" ? "apps.files.sourceVolumes" : "apps.files.sourceContainer")}
            </ChipButton>
          ))}
        </div>
      )}

      {notes.length > 0 && <div style={{ display: "grid", gap: 8, marginBottom: 12 }}>{notes}</div>}

      {/* Volume picker — only when the app declares more than one. */}
      {scope === "volume" && volumes.length > 1 && (
        <div role="group" aria-label={t("apps.files.volumeLabel")} style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
          {volumes.map((v) => (
            <ChipButton key={v.name} pressed={v.name === volume} title={v.name} onClick={() => openVolume(v.name)}>
              {v.name}
            </ChipButton>
          ))}
        </div>
      )}

      {/* COMPOSE apps pick which of their containers to browse. */}
      {needsPicker && containerList.length > 1 && (
        <div style={{ marginBottom: 12, maxWidth: 360 }}>
          <Select
            ariaLabel={t("apps.files.containerPicker")}
            value={containerName}
            onChange={(v) => {
              setPickedContainer(v);
              go("/");
            }}
            options={containerList.map((c) => ({ value: c.name, label: c.name }))}
          />
        </div>
      )}

      {/* Container mode: an editable path field plus quick links (a huge tree can't be listed completely). */}
      {scope === "container" && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 12 }}>
          <label htmlFor={`ctr-path-${id}`} style={{ fontSize: 12, fontWeight: 600, color: "var(--c-tx2)" }}>{t("apps.files.pathField")}</label>
          <div style={{ flex: 1, minWidth: 180 }}>
            <TextInput
              id={`ctr-path-${id}`}
              mono
              value={pathDraft}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setPathDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && pathDraft.startsWith("/")) go(pathDraft.length > 1 ? pathDraft.replace(/\/+$/, "") : pathDraft);
              }}
            />
          </div>
          <span role="group" aria-label={t("apps.files.quickLinks")} style={{ display: "inline-flex", gap: 6 }}>
            {["/app", "/etc", "/"].map((p) => (
              <ChipButton key={p} pressed={cpath === p} onClick={() => go(p)}>{p}</ChipButton>
            ))}
          </span>
        </div>
      )}

      {/* Toolbar */}
      {canWrite && (
        <div role="toolbar" aria-label={t("apps.files.toolbarLabel")} style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
          <Btn variant="ghost" icon={RefreshCw} onClick={refreshList}>{t("apps.files.refresh")}</Btn>
          {writable && (
            <>
              <Btn variant="ghost" icon={FilePlus} onClick={() => setDialog({ kind: "new", type: "file" })}>{t("apps.files.newFile")}</Btn>
              <Btn variant="ghost" icon={FolderPlus} onClick={() => setDialog({ kind: "new", type: "folder" })}>{t("apps.files.newFolder")}</Btn>
              <Btn variant="ghost" icon={Upload} onClick={() => fileInput.current?.click()}>{t("apps.files.upload")}</Btn>
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                aria-label={t("apps.files.uploadHint")}
                onChange={(e) => {
                  const list = Array.from(e.target.files ?? []);
                  e.target.value = "";
                  if (list.length > 0) uploads.add(list, target, pathOf);
                }}
              />
            </>
          )}
        </div>
      )}

      {actionError && <div role="alert" style={{ fontSize: 12, color: "var(--c-r)", marginBottom: 10 }}>{actionError}</div>}

      {/* Breadcrumb: root + each path segment, all clickable. */}
      <nav aria-label={t("apps.files.breadcrumbLabel")} style={{ marginBottom: 12 }}>
        <ol style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 2, listStyle: "none", margin: 0, padding: 0, fontSize: 13, minWidth: 0 }}>
          <li style={{ display: "inline-flex", alignItems: "center", minWidth: 0 }}>
            <Crumb
              label={scope === "container" ? "/" : volume || t("apps.files.root")}
              onClick={() => go(scope === "container" ? "/" : "")}
              active={segments.length === 0}
              activeRef={activeCrumbRef}
            />
          </li>
          {segments.map((seg, i) => {
            const upto = pathUpTo(scope, segments, i + 1);
            const active = i === segments.length - 1;
            return (
              <li key={upto} style={{ display: "inline-flex", alignItems: "center", gap: 2, minWidth: 0 }}>
                <ChevronRight size={14} color="var(--c-tx3)" aria-hidden style={{ flexShrink: 0 }} />
                <Crumb label={seg} onClick={() => go(upto)} active={active} activeRef={activeCrumbRef} />
              </li>
            );
          })}
        </ol>
      </nav>

      <UploadQueuePanel items={uploads.items} onCancel={uploads.cancel} onRetry={uploads.retry} onClear={uploads.clearFinished} />

      {firstLoad && (
        <div role="status" aria-live="polite" aria-label={t("apps.files.loading")} style={{ padding: 24, display: "flex", justifyContent: "center" }}>
          <Spinner />
        </div>
      )}

      {q.isError && (
        <EmptyState icon={Folder} title={t("apps.files.loadError")}>
          {describeError(q.error)}
        </EmptyState>
      )}

      {q.data && !q.isError && (
        // Dim the list while a navigation is in flight (keepPreviousData keeps it mounted).
        <div
          onDragEnter={(e) => onDrag(e, true)}
          onDragOver={(e) => onDrag(e, true)}
          onDragLeave={(e) => {
            if (e.currentTarget === e.target) onDrag(e, false);
          }}
          onDrop={onDrop}
          style={{ position: "relative", opacity: q.isFetching ? 0.55 : 1, transition: "opacity .12s" }}
          aria-busy={q.isFetching}
        >
          {dragging && (
            <div
              role="status"
              style={{ position: "absolute", inset: 0, zIndex: 2, display: "flex", alignItems: "center", justifyContent: "center", border: "2px dashed var(--c-a)", borderRadius: "var(--r1)", background: "color-mix(in srgb, var(--c-bg) 80%, transparent)", fontSize: 13, fontWeight: 600, textAlign: "center", padding: 12 }}
            >
              {t("apps.files.dropHere", { path: scope === "container" ? path : `/${path}` })}
            </div>
          )}
          {entries.length === 0 ? (
            <EmptyState icon={Folder}>{t("apps.files.empty")}</EmptyState>
          ) : (
            <div style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", overflow: "hidden" }}>
              {entries.map((e, i) => (
                <FileRow
                  key={e.name}
                  entry={e}
                  first={i === 0}
                  onOpen={e.type === "dir" ? () => go(joinPath(scope, path, e.name)) : undefined}
                  symlinkLabel={t("apps.files.symlink")}
                  menu={menuFor(e)}
                  menuLabel={t("apps.files.actionsFor", { name: e.name })}
                />
              ))}
            </div>
          )}
          {q.data.truncated && (
            <p style={{ fontSize: 12, color: "var(--c-am)", marginTop: 10 }}>
              {scope === "container" ? t("apps.files.containerTruncated") : t("apps.files.truncated", { count: entries.length })}
            </p>
          )}
        </div>
      )}

      {/* ── dialogs ── */}
      {dialog?.kind === "new" && (
        <NewEntryDialog
          kind={dialog.type}
          busy={busy}
          error={dialogError}
          onClose={closeDialog}
          onSubmit={(name) => {
            if (dialog.type === "file") setDialog({ kind: "edit", name, isNew: true });
            else void runDialog(() => mutate((ack) => filesApi.mkdir(id, target, pathOf(name), { acknowledgeRisk: ack })));
          }}
        />
      )}
      {dialog?.kind === "rename" && (
        <RenameDialog
          name={dialog.entry.name}
          busy={busy}
          error={dialogError}
          onClose={closeDialog}
          onSubmit={(to) => void runDialog(() => mutate((ack) => filesApi.rename(id, target, pathOf(dialog.entry.name), joinPath(scope, dirOfEntry, to), { acknowledgeRisk: ack })))}
        />
      )}
      {dialog?.kind === "chmod" && (
        <ChmodDialog
          name={dialog.entry.name}
          initialMode={dialog.mode}
          busy={busy}
          error={dialogError}
          onClose={closeDialog}
          onSubmit={(mode) => void runDialog(() => mutate((ack) => filesApi.chmod(id, target, pathOf(dialog.entry.name), mode, { acknowledgeRisk: ack })))}
        />
      )}
      {dialog?.kind === "delete" && (
        <DeleteConfirmDialog
          name={dialog.entry.name}
          isDir={dialog.entry.type === "dir"}
          notEmpty={dialog.notEmpty}
          busy={busy}
          error={dialogError}
          onClose={closeDialog}
          onConfirm={(recursive) =>
            void runDialog(
              () => mutate((ack) => filesApi.deleteEntry(id, target, pathOf(dialog.entry.name), { recursive, acknowledgeRisk: ack })),
              () => setDialog({ kind: "delete", entry: dialog.entry, notEmpty: true }),
            )
          }
        />
      )}
      {dialog?.kind === "edit" && (
        <AppFileEditor
          id={id}
          target={target}
          path={pathOf(dialog.name)}
          name={dialog.name}
          maxEditBytes={limits?.maxEditBytes ?? 1024 * 1024}
          writable={writable}
          isNew={dialog.isNew}
          requestAck={scope === "volume" ? requestAck : undefined}
          onClose={closeDialog}
          onSaved={refreshList}
        />
      )}
      {uploads.conflict && (
        <OverwriteDialog
          name={uploads.conflict.name}
          onOverwrite={() => uploads.resolveConflict(uploads.conflict!.uid, "overwrite")}
          onSkip={() => uploads.resolveConflict(uploads.conflict!.uid, "skip")}
        />
      )}
      {uploads.needsAck && !ackAsk && (
        <DatastoreAckDialog onConfirm={() => uploads.resolveAck(uploads.needsAck!.uid, true)} onClose={() => uploads.resolveAck(uploads.needsAck!.uid, false)} />
      )}
      {ackAsk && (
        <DatastoreAckDialog
          onConfirm={() => {
            ackAsk.resolve(true);
            setAckAsk(null);
          }}
          onClose={() => {
            ackAsk.resolve(false);
            setAckAsk(null);
          }}
        />
      )}
    </div>
  );
}

function Note({ tone, children }: { tone: "info" | "warn" | "muted"; children: ReactNode }) {
  const color = tone === "warn" ? "var(--c-am)" : tone === "info" ? "var(--c-lapis)" : "var(--c-tx3)";
  return (
    <div
      role={tone === "muted" ? undefined : "note"}
      style={{ fontSize: 12, lineHeight: 1.5, color: tone === "muted" ? "var(--c-tx3)" : "var(--c-tx2)", padding: tone === "muted" ? 0 : "8px 10px", border: tone === "muted" ? "none" : `1px solid color-mix(in srgb, ${color} 45%, var(--c-bd))`, borderRadius: "var(--r1)", background: tone === "muted" ? "transparent" : `color-mix(in srgb, ${color} 8%, var(--c-el))` }}
    >
      {children}
    </div>
  );
}

function ChipButton({ pressed, onClick, title, children }: { pressed: boolean; onClick: () => void; title?: string; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      title={title}
      onClick={onClick}
      style={{
        fontFamily: "inherit",
        fontSize: 12,
        fontWeight: 600,
        padding: "5px 10px",
        borderRadius: "var(--r1)",
        cursor: "pointer",
        border: "1px solid var(--c-bd)",
        background: pressed ? "var(--c-a)" : "var(--c-el)",
        color: pressed ? "var(--c-on-a)" : "var(--c-tx)",
        maxWidth: "100%",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </button>
  );
}

function Crumb({
  label,
  onClick,
  active,
  activeRef,
}: {
  label: string;
  onClick: () => void;
  active: boolean;
  activeRef: React.RefObject<HTMLButtonElement | null>;
}) {
  return (
    <button
      ref={active ? activeRef : undefined}
      type="button"
      // The active crumb isn't `disabled` (that would drop it from tab order and steal focus); it's
      // marked aria-current + aria-disabled and its onClick is a no-op.
      aria-current={active ? "page" : undefined}
      aria-disabled={active || undefined}
      title={label}
      onClick={active ? undefined : onClick}
      style={{
        fontFamily: "inherit",
        fontSize: 13,
        fontWeight: active ? 600 : 500,
        padding: "2px 6px",
        borderRadius: 6,
        border: "none",
        background: "transparent",
        color: active ? "var(--c-tx)" : "var(--c-lapis)",
        cursor: active ? "default" : "pointer",
        maxWidth: "100%",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </button>
  );
}

function FileRow({
  entry,
  first,
  onOpen,
  symlinkLabel,
  menu,
  menuLabel,
}: {
  entry: FileEntry;
  first: boolean;
  onOpen?: () => void;
  symlinkLabel: string;
  menu: MenuItem[];
  menuLabel: string;
}) {
  const Icon = entry.type === "dir" ? Folder : entry.type === "symlink" ? Link2 : FileIcon;
  const inner = (
    <>
      <Icon size={16} color={entry.type === "dir" ? "var(--c-a)" : "var(--c-tx3)"} aria-hidden style={{ flexShrink: 0 }} />
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--c-tx)" }}>
        {entry.name}
        {entry.type === "symlink" && (
          <span style={{ marginLeft: 8 }}>
            <Badge>{symlinkLabel}</Badge>
          </span>
        )}
      </span>
      <span aria-hidden className="mono" style={{ fontSize: 12, color: "var(--c-tx3)", flexShrink: 0, width: 72, textAlign: "right" }}>
        {entry.type === "dir" ? "—" : fmtBytes(entry.size)}
      </span>
      <span aria-hidden style={{ fontSize: 12, color: "var(--c-tx3)", flexShrink: 0, width: 150, textAlign: "right" }} className="hide-narrow">
        {entry.mtime ? new Date(entry.mtime * 1000).toLocaleString() : ""}
      </span>
    </>
  );
  const rowStyle = {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "9px 12px",
    borderTop: first ? "none" : "1px solid var(--c-bd)",
    width: "100%",
    boxSizing: "border-box" as const,
    textAlign: "left" as const,
    background: "transparent",
    fontFamily: "inherit",
    fontSize: 13,
  };
  const body = onOpen ? (
    // accessible name = the entry name only (the size/mtime meta spans are aria-hidden).
    <button
      type="button"
      aria-label={entry.name}
      onClick={onOpen}
      style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0, padding: 0, border: "none", background: "transparent", fontFamily: "inherit", fontSize: 13, textAlign: "left", cursor: "pointer" }}
    >
      {inner}
    </button>
  ) : (
    <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0 }}>{inner}</div>
  );
  return (
    <div style={rowStyle}>
      {body}
      {menu.length > 0 && <Menu items={menu} label={menuLabel} />}
    </div>
  );
}
