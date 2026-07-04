"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Globe, Play, RotateCw, Square, Trash2, type LucideIcon } from "lucide-react";
import { api } from "../lib/api";
import { tileActions, type LauncherTile, type TileAction } from "../lib/launcher";
import { useT } from "../i18n/provider";
import { Modal } from "./modal";
import { AppLogo } from "./app-logo";
import { useToast } from "./toast";
import { useConfirm } from "./confirm";

/** Manage an installed app from the Home launcher (open/start/stop/restart/domain/uninstall). */
export function TileActionsSheet({
  tile,
  onClose,
  onAddDomain,
}: {
  tile: LauncherTile;
  onClose: () => void;
  onAddDomain: (id: string) => void;
}) {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();

  const run = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["apps"] });
      toast(t("home.actionDone"), "success");
      onClose();
    },
  });

  const ICON: Record<TileAction, LucideIcon> = {
    open: ExternalLink,
    start: Play,
    restart: RotateCw,
    stop: Square,
    addDomain: Globe,
    uninstall: Trash2,
  };

  const handle = async (action: TileAction) => {
    switch (action) {
      case "open":
        if (tile.url) window.open(tile.url, "_blank", "noreferrer");
        onClose();
        return;
      case "start":
        return run.mutate(() => api.deployApp(tile.id));
      case "restart":
        return run.mutate(() => api.restartApp(tile.id));
      case "stop":
        return run.mutate(() => api.stopApp(tile.id));
      case "addDomain":
        onClose();
        onAddDomain(tile.id);
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
        <span style={{ width: 34, height: 34, borderRadius: 9, background: "rgba(255,255,255,0.06)", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
          <AppLogo templateSlug={tile.templateSlug} templateLogo={tile.templateLogo} source={tile.source} name={tile.name} size={20} />
        </span>
        <div style={{ fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{tile.name}</div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {tileActions(tile.status, !!tile.url).map((action) => {
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
    </Modal>
  );
}
