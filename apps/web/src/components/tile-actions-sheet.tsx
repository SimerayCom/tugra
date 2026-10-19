"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Globe, Pin, PinOff, Play, RefreshCw, RotateCw, ScrollText, Square, Trash2, type LucideIcon } from "lucide-react";
import { api } from "../lib/api";
import { tileActions, type LauncherTile, type TileAction } from "../lib/launcher";
import { useT } from "../i18n/provider";
import { Modal } from "./modal";
import { Btn, Spinner } from "./ui";
import { AppLogo } from "./app-logo";
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

  const logs = useQuery({
    queryKey: ["apps", tile.id, "logs"],
    queryFn: () => api.getAppLogs(tile.id, 200),
    enabled: showLogs,
  });

  const run = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["apps"] });
      toast(t("home.actionDone"), "success");
      onClose();
    },
    // A failed action (409 already-deploying, 403, …) must not fail silently — the sheet stays open.
    onError: (e) => toast(e instanceof Error ? e.message : t("home.actionFailed"), "error"),
  });

  const ICON: Record<TileAction, LucideIcon> = {
    open: ExternalLink,
    logs: ScrollText,
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
      case "start":
      case "update": // redeploy: pull latest + restart (same deploy endpoint)
        return run.mutate(() => api.deployApp(tile.id));
      case "restart":
        return run.mutate(() => api.restartApp(tile.id));
      case "stop":
        return run.mutate(() => api.stopApp(tile.id));
      case "expose":
        onClose();
        onExpose(tile.id);
        return;
      case "uninstall":
        if (await confirm({ title: t("home.uninstall"), body: t("home.uninstallConfirm", { name: tile.name }), danger: true })) {
          run.mutate(() => api.deleteApp(tile.id));
        }
        return;
    }
  };

  return (
    <Modal onClose={onClose}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <span style={{ width: 34, height: 34, borderRadius: 9, background: "color-mix(in srgb, var(--c-tx) 8%, transparent)", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
          <AppLogo templateSlug={tile.templateSlug} templateLogo={tile.templateLogo} source={tile.source} name={tile.name} size={20} />
        </span>
        <div style={{ fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{tile.name}</div>
      </div>

      {showLogs ? (
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
