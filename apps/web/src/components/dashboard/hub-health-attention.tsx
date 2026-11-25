"use client";

import { AlertTriangle } from "lucide-react";
import { useT } from "../../i18n/provider";
import { warningText } from "../../hooks/useHubHealth";
import { ListCard, ListRow } from "../list";
import type { HubHealthWarning } from "../../lib/types";

/** The compact "hub health" line in Needs attention: only rendered while the owner's hub reports warnings. */
export function HubHealthAttention({ warnings, spaced }: { warnings: HubHealthWarning[]; spaced?: boolean }) {
  const t = useT();
  if (warnings.length === 0) return null;
  return (
    <div style={{ marginBottom: spaced ? 8 : 0 }} data-testid="hub-health-attention">
      <ListCard>
        <ListRow index={0} href="/settings?tab=instance&section=general#hub-health" style={{ gap: 10, padding: "11px 16px" }}>
          <AlertTriangle size={15} color="var(--c-am)" style={{ flexShrink: 0 }} aria-hidden />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 14 }}>{t("dashboard.attentionHub")}</div>
            <div style={{ fontSize: 11, color: "var(--c-tx3)" }}>{warningText(t, warnings[0])}</div>
          </div>
          <span style={{ fontSize: 12, color: "var(--c-am)", fontWeight: 600 }}>{t("dashboard.attentionHubWarn", { n: warnings.length })}</span>
        </ListRow>
      </ListCard>
    </div>
  );
}
