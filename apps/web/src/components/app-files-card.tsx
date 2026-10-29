"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { Folder, File as FileIcon, Link2, ChevronRight, HardDrive } from "lucide-react";
import { api, ApiError } from "../lib/api";
import type { AppVolume, FileEntry } from "../lib/types";
import { fmtBytes } from "../lib/fleet";
import { useT } from "../i18n/provider";
import { Spinner, EmptyState, Badge } from "./ui";

/**
 * Read-only file browser for one app's declared volumes. Shared by the fleet app-detail
 * "Files" tab and the Home launcher's inline files view. Lists metadata only (name/type/size/mtime); it
 * never fetches file contents. Directories are navigable; symlinks are shown but never followed.
 */
export function AppFilesCard({ id, volumes }: { id: string; volumes: AppVolume[] }) {
  const t = useT();
  const [volume, setVolume] = useState(volumes[0]?.name ?? "");
  const [path, setPath] = useState("");
  // After a navigation we move keyboard focus to the active breadcrumb crumb, so keyboard/SR users don't
  // get dropped to <body> when the list re-renders. Guarded so we don't steal focus on first mount.
  const navigatedRef = useRef(false);
  const activeCrumbRef = useRef<HTMLButtonElement>(null);

  const q = useQuery({
    queryKey: ["app", id, "files", volume, path],
    queryFn: () => api.listAppFiles(id, volume, path),
    enabled: !!volume,
    // Keep the current list mounted while the next folder loads — no spinner flash, no focus loss.
    placeholderData: keepPreviousData,
  });

  useEffect(() => {
    if (navigatedRef.current) {
      navigatedRef.current = false;
      activeCrumbRef.current?.focus();
    }
  }, [volume, path]);

  if (volumes.length === 0) {
    return (
      <EmptyState icon={HardDrive} title={t("apps.files.noVolumesTitle")}>
        {t("apps.files.noVolumes")}
      </EmptyState>
    );
  }

  const segments = path ? path.split("/") : [];
  const go = (p: string) => {
    navigatedRef.current = true;
    setPath(p);
  };
  const openVolume = (name: string) => {
    if (name === volume) return;
    navigatedRef.current = true;
    setVolume(name);
    setPath("");
  };

  // Directories first, then alphabetical — a conventional file-manager order.
  const entries = q.data
    ? [...q.data.entries].sort(
        (a, b) => (a.type === "dir" ? 0 : 1) - (b.type === "dir" ? 0 : 1) || a.name.localeCompare(b.name),
      )
    : [];
  const firstLoad = q.isPending && !q.data;

  return (
    <div>
      {/* Volume picker — only when the app declares more than one. */}
      {volumes.length > 1 && (
        <div role="group" aria-label={t("apps.files.volumeLabel")} style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
          {volumes.map((v) => (
            <button
              key={v.name}
              type="button"
              aria-pressed={v.name === volume}
              title={v.name}
              onClick={() => openVolume(v.name)}
              style={{
                fontFamily: "inherit",
                fontSize: 12,
                fontWeight: 600,
                padding: "5px 10px",
                borderRadius: "var(--r1)",
                cursor: "pointer",
                border: "1px solid var(--c-bd)",
                background: v.name === volume ? "var(--c-a)" : "var(--c-el)",
                color: v.name === volume ? "var(--c-on-a)" : "var(--c-tx)",
                maxWidth: "100%",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {v.name}
            </button>
          ))}
        </div>
      )}

      {/* Breadcrumb: volume root + each path segment, all clickable. */}
      <nav aria-label={t("apps.files.breadcrumbLabel")} style={{ marginBottom: 12 }}>
        <ol style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 2, listStyle: "none", margin: 0, padding: 0, fontSize: 13, minWidth: 0 }}>
          <li style={{ display: "inline-flex", alignItems: "center", minWidth: 0 }}>
            <Crumb
              label={volume || t("apps.files.root")}
              onClick={() => go("")}
              active={segments.length === 0}
              activeRef={activeCrumbRef}
            />
          </li>
          {segments.map((seg, i) => {
            const upto = segments.slice(0, i + 1).join("/");
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

      {firstLoad && (
        <div role="status" aria-live="polite" aria-label={t("apps.files.loading")} style={{ padding: 24, display: "flex", justifyContent: "center" }}>
          <Spinner />
        </div>
      )}

      {q.isError && (
        <EmptyState icon={Folder} title={t("apps.files.loadError")}>
          {q.error instanceof ApiError ? q.error.message : String(q.error)}
        </EmptyState>
      )}

      {q.data && !q.isError && (
        // Dim the list while a navigation is in flight (keepPreviousData keeps it mounted).
        <div style={{ opacity: q.isFetching ? 0.55 : 1, transition: "opacity .12s" }} aria-busy={q.isFetching}>
          {entries.length === 0 ? (
            <EmptyState icon={Folder}>{t("apps.files.empty")}</EmptyState>
          ) : (
            <div style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", overflow: "hidden" }}>
              {entries.map((e, i) => (
                <FileRow
                  key={e.name}
                  entry={e}
                  first={i === 0}
                  onOpen={e.type === "dir" ? () => go(path ? `${path}/${e.name}` : e.name) : undefined}
                  symlinkLabel={t("apps.files.symlink")}
                />
              ))}
            </div>
          )}
          {q.data.truncated && (
            <p style={{ fontSize: 12, color: "var(--c-am)", marginTop: 10 }}>
              {t("apps.files.truncated", { count: entries.length })}
            </p>
          )}
        </div>
      )}
    </div>
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
}: {
  entry: FileEntry;
  first: boolean;
  onOpen?: () => void;
  symlinkLabel: string;
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
    textAlign: "left" as const,
    background: "transparent",
    fontFamily: "inherit",
    fontSize: 13,
  };
  if (onOpen) {
    // accessible name = the entry name only (the size/mtime meta spans are aria-hidden).
    return (
      <button type="button" aria-label={entry.name} onClick={onOpen} style={{ ...rowStyle, border: "none", cursor: "pointer" }}>
        {inner}
      </button>
    );
  }
  return <div style={rowStyle}>{inner}</div>;
}
