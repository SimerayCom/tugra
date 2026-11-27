"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, FolderOpen, Globe, Pin, PinOff, Play, RefreshCw, RotateCw, ScrollText, Square, Trash2, type LucideIcon } from "lucide-react";
import { api } from "../lib/api";
import { tileActions, type LauncherTile, type TileAction } from "../lib/launcher";
import { useT } from "../i18n/provider";
import { Modal } from "./modal";
import { Btn, Spinner } from "./ui";
import { AppFilesCard } from "./app-files-card";
import { AppLogo } from "./app-logo";
import { appLogoProps } from "../lib/app-icon";
import { useToast } from "./toast";
import { useConfirm } from "./confirm";

/** Manage an installed app from the Home launcher (open/start/stop/restart/domain/uninstall). */
export function TileActionsSheet({
  tile,
  pinned,
  onTogglePin,
  onClose,
  onExpose,
}: {
  tile: LauncherTile;
  pinned?: boolean;
  onTogglePin?: () => void;
  onClose: () => void;
  onExpose: (id: string) => void;
}) {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [showLogs, setShowLogs] = useState(false);
  const [showFiles, setShowFiles] = useState(false);

  const logs = useQuery({
    queryKey: ["apps", tile.id, "logs"],
    queryFn: () => api.getAppLogs(tile.id, 200),
    enabled: showLogs,
  });

  // The "files" action is only offered to writers (tileActions), so tile.canWrite is true when the files view opens;
  // it is passed through so the write UI is gated on that same flag.
  // The tile doesn't carry volumes; fetch the app lazily when the files view opens (no navigation — Home-safe).
  const appForFiles = useQuery({
    queryKey: ["app", tile.id],
    queryFn: () => api.getApp(tile.id),
    enabled: showFiles,
  });

  // `done` is the named, keyed toast for the action (same keys the app page uses for its lifecycle buttons).
  const run = useMutation({
    mutationFn: (a: { fn: () => Promise<unknown>; done: string }) => a.fn(),
    onSuccess: async (_r, a) => {
      await qc.invalidateQueries({ queryKey: ["apps"] });
      toast(t(a.done, { name: tile.name }), "success");
      onClose();
    },
    // A failed action (409 already-deploying, 403, …) must not fail silently — the sheet stays open.
    onError: (e) => toast(e instanceof Error ? e.message : t("home.actionFailed"), "error"),
  });

  const ICON: Record<TileAction, LucideIcon> = {
    open: ExternalLink,
    logs: ScrollText,
    files: FolderOpen,
    start: Play,
    restart: RotateCw,
    update: RefreshCw,
    stop: Square,
    expose: Globe,
    uninstall: Trash2,
  };

  const handle = async (action: TileAction) => {
    switch (action) {
      case "open":
        if (tile.url) window.open(tile.url, "_blank", "noreferrer");
        onClose();
        return;
      case "logs":
        setShowLogs(true); // open the inline logs view (no navigation — works in Home mode)
        return;
      case "files":
        setShowFiles(true); // open the inline files browser (no navigation — works in Home mode)
        return;
      case "start":
      case "update": // redeploy: pull latest + restart (same deploy endpoint)
        return run.mutate({ fn: () => api.deployApp(tile.id), done: action === "start" ? "apps.started" : "home.deployStarted" });
      case "restart":
        return run.mutate({ fn: () => api.restartApp(tile.id), done: "apps.restarted" });
      case "stop":
        return run.mutate({ fn: () => api.stopApp(tile.id), done: "apps.stopped" });
      case "expose":
        onClose();
        onExpose(tile.id);
        return;
      case "uninstall":
        if (await confirm({ title: t("home.uninstall"), body: t("home.uninstallConfirm", { name: tile.name }), danger: true })) {
          run.mutate({ fn: () => api.deleteApp(tile.id), done: "home.uninstalled" });
        }
        return;
    }
  };

  return (
    <Modal onClose={onClose} ariaLabel={tile.name}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <span style={{ width: 34, height: 34, borderRadius: 9, background: "color-mix(in srgb, var(--c-tx) 8%, transparent)", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
          <AppLogo {...appLogoProps(tile)} size={20} />
        </span>
        <div style={{ fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{tile.name}</div>
      </div>

      {showFiles ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {appForFiles.isPending ? (
            <div style={{ display: "flex", justifyContent: "center", padding: 16 }}><Spinner /></div>
          ) : appForFiles.isError ? (
            <div style={{ fontSize: 13, color: "var(--c-r)", padding: 8 }}>{t("home.filesError")}</div>
          ) : (
            <AppFilesCard id={tile.id} volumes={appForFiles.data?.volumes ?? []} canWrite={tile.canWrite} serverId={appForFiles.data?.serverId} />
          )}
          <div>
            <Btn variant="ghost" onClick={() => setShowFiles(false)}>{t("home.logsBack")}</Btn>
          </div>
        </div>
      ) : showLogs ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {logs.isPending ? (
            <div style={{ display: "flex", justifyContent: "center", padding: 16 }}><Spinner /></div>
          ) : logs.isError ? (
            // A real fetch failure (403/404/container gone) must read as an error, not an empty app.
            <div style={{ fontSize: 13, color: "var(--c-r)", padding: 8 }}>{t("home.logsError")}</div>
          ) : (
            <pre tabIndex={0} aria-label={t("home.action_logs")} style={{ maxHeight: 320, overflow: "auto", fontSize: 11, lineHeight: 1.45, background: "var(--c-bg)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: 10, margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {logs.data?.output?.trim() || t("home.logsEmpty")}
            </pre>
          )}
          <div style={{ display: "flex", gap: 10 }}>
            <Btn variant="ghost" onClick={() => setShowLogs(false)}>{t("home.logsBack")}</Btn>
            {/* Logs are a snapshot — let the user pull a fresh tail (a crash-looping app changes). */}
            <Btn variant="ghost" onClick={() => logs.refetch()} disabled={logs.isFetching}>{logs.isFetching ? "…" : t("home.logsRefresh")}</Btn>
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {onTogglePin && (
            <button
              onClick={() => { onTogglePin(); onClose(); }}
              style={{
                display: "flex", alignItems: "center", gap: 10, width: "100%", textAlign: "left",
                padding: "11px 12px", borderRadius: "var(--r1)", cursor: "pointer", fontSize: 14, fontFamily: "inherit",
                background: "var(--c-el)", border: "1px solid var(--c-bd)", color: "var(--c-tx)",
              }}
            >
              {pinned ? <PinOff size={16} /> : <Pin size={16} />} {t(pinned ? "home.unpin" : "home.pin")}
            </button>
          )}
          {tileActions(tile.status, !!tile.url, tile.canWrite).map((action) => {
            const Icon = ICON[action];
            const danger = action === "uninstall";
            return (
              <button
                key={action}
                onClick={() => handle(action)}
                disabled={run.isPending}
                style={{
                  display: "flex", alignItems: "center", gap: 10, width: "100%", textAlign: "left",
                  padding: "11px 12px", borderRadius: "var(--r1)", cursor: "pointer", fontSize: 14, fontFamily: "inherit",
                  background: "var(--c-el)", border: "1px solid var(--c-bd)",
                  color: danger ? "var(--c-r)" : "var(--c-tx)",
                }}
              >
                <Icon size={16} /> {t(`home.action_${action}`)}
              </button>
            );
          })}
        </div>
      )}
    </Modal>
  );
}
