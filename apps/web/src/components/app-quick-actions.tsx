"use client";

import { RotateCw, ScrollText, Undo2 } from "lucide-react";
import { useT } from "../i18n/provider";
import { Btn } from "./ui";

/**
 * Thumb-reach bar for an app on a phone: restart, roll back, view logs. The page owns the mutations and the confirm
 * dialog (the same endpoints the desktop header and the deployment page use); this only lays the three actions out.
 * Rollback is disabled, with the reason as its title, when there is no earlier version to return to.
 */
export function AppQuickActions({
  canWrite,
  running,
  locked,
  lockTitle,
  restartPending,
  rollbackPending,
  canRollback,
  onRestart,
  onRollback,
  onLogs,
}: {
  canWrite: boolean;
  running: boolean;
  locked: boolean;
  lockTitle?: string;
  restartPending: boolean;
  rollbackPending: boolean;
  canRollback: boolean;
  onRestart: () => void;
  onRollback: () => void;
  onLogs: () => void;
}) {
  const t = useT();
  const bar: React.CSSProperties = {
    position: "fixed",
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 30, // above page content, below dialogs (50) and toasts (100)
    display: "grid",
    gridTemplateColumns: canWrite ? "repeat(3, 1fr)" : "1fr",
    gap: 8,
    padding: "10px calc(12px + env(safe-area-inset-right, 0px)) calc(10px + env(safe-area-inset-bottom, 0px)) calc(12px + env(safe-area-inset-left, 0px))",
    background: "var(--c-sb)",
    borderTop: "1px solid var(--c-bd)",
  };
  const big: React.CSSProperties = { minHeight: 44, width: "100%" }; // 44px touch target
  return (
    <nav aria-label={t("apps.quickActions")} data-testid="app-quick-actions" style={bar}>
      {canWrite && (
        <Btn variant="ghost" icon={RotateCw} iconTone="warn" style={big} loading={restartPending} disabled={!running || locked} title={locked ? lockTitle : t("apps.restartHint")} onClick={onRestart}>
          {t("apps.quickRestart")}
        </Btn>
      )}
      {canWrite && (
        <Btn
          variant="ghost"
          icon={Undo2}
          style={big}
          loading={rollbackPending}
          disabled={!canRollback || locked}
          title={locked ? lockTitle : canRollback ? t("apps.quickRollbackHint") : t("apps.quickRollbackNone")}
          onClick={onRollback}
        >
          {t("apps.quickRollback")}
        </Btn>
      )}
      <Btn variant="ghost" icon={ScrollText} style={big} onClick={onLogs}>{t("apps.quickLogs")}</Btn>
    </nav>
  );
}
