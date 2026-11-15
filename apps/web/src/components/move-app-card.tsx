"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useT } from "../i18n/provider";
import type { Application } from "../lib/types";
import { Btn, SectionCard } from "./ui";
import { MoveAppModal } from "./move-app-modal";

/**
 * The "Move to server" entry in the app's General settings (like the database's server card). Disabled with the reason
 * while a move is live and for clustered (swarm) apps; hidden for read-only members by the config-group gating.
 */
export function MoveAppCard({ app }: { app: Pick<Application, "id" | "name" | "teamId" | "serverId" | "clusterId" | "move"> }) {
  const t = useT();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const clustered = !!app.clusterId;
  const locked = !!app.move;
  const disabled = clustered || locked;
  // The page's lock, the banner and the disabled lifecycle buttons all read the app's `move`: refetch it NOW instead of on the next poll.
  const onStarted = (): void => {
    void qc.invalidateQueries({ queryKey: ["app", app.id] });
    void qc.invalidateQueries({ queryKey: ["app-moves", app.id] });
    void qc.invalidateQueries({ queryKey: ["deployments", app.id] });
  };
  const reason = locked ? t("apps.moveLockedTooltip") : clustered ? t("apps.moveClusteredDisabled") : undefined;
  return (
    <SectionCard title={t("apps.moveTitle")} desc={t("apps.moveDesc")}>
      {reason && <p role="note" style={{ fontSize: 12, color: "var(--c-am)", margin: "0 0 10px" }}>{reason}</p>}
      <Btn variant="ghost" disabled={disabled} title={reason} onClick={() => setOpen(true)}>{t("apps.moveAction")}</Btn>
      {open && <MoveAppModal appId={app.id} appName={app.name} teamId={app.teamId} currentServerId={app.serverId} onClose={() => setOpen(false)} onStarted={onStarted} />}
    </SectionCard>
  );
}
