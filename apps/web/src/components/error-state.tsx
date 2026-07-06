"use client";

import { AlertTriangle } from "lucide-react";
import { useT } from "../i18n/provider";
import { Btn } from "./ui";

/**
 * Shown in place of a list/detail when its query fails — so a failed fetch reads
 * as an error (with retry), not as a misleading empty state or an endless spinner.
 * Mirrors EmptyState's layout.
 */
export function ErrorState({ onRetry }: { onRetry?: () => void }) {
  const t = useT();
  return (
    <div style={{ padding: "44px 28px", textAlign: "center" }}>
      <div style={{ width: 44, height: 44, borderRadius: 12, background: "var(--c-el)", border: "1px solid var(--c-bd)", display: "inline-flex", alignItems: "center", justifyContent: "center", marginBottom: 14 }}>
        <AlertTriangle size={20} color="var(--c-r)" />
      </div>
      <div style={{ fontSize: 15, fontWeight: 600, color: "var(--c-tx)", marginBottom: 4 }}>{t("errors.errorTitle")}</div>
      <div style={{ fontSize: 13, color: "var(--c-tx3)", maxWidth: 380, margin: "0 auto", lineHeight: 1.5 }}>{t("errors.errorDesc")}</div>
      {onRetry && (
        <div style={{ marginTop: 16 }}>
          <Btn variant="ghost" onClick={onRetry}>{t("errors.retry")}</Btn>
        </div>
      )}
    </div>
  );
}
