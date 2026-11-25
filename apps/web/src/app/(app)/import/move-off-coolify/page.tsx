"use client";

import Link from "next/link";
import { useT } from "../../../../i18n/provider";
import { CoolifyMoveChecklist } from "../../../../components/coolify-move-checklist";
import { HelpLink } from "../../../../components/help-link";

export default function MoveOffCoolifyPage() {
  const t = useT();
  return (
    <div style={{ padding: "24px 20px", maxWidth: 900, margin: "0 auto" }}>
      <p style={{ fontSize: 12, margin: "0 0 8px" }}>
        <Link href="/import" className="tg-link">{t("coolifyTakeover.back")}</Link>
      </p>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, margin: "0 0 2px" }}>{t("coolifyMove.title")}</h1>
        <HelpLink guide="move-off-coolify" />
      </div>
      <p style={{ fontSize: 13, color: "var(--c-tx3)", margin: "0 0 20px" }}>{t("coolifyMove.subtitle")}</p>
      <CoolifyMoveChecklist />
    </div>
  );
}
