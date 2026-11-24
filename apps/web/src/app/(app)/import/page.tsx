"use client";

import Link from "next/link";
import { useT } from "../../../i18n/provider";
import { ImportWizard } from "../../../components/import-wizard";
import { HelpLink } from "../../../components/help-link";

export default function ImportPage() {
  const t = useT();
  return (
    <div style={{ padding: "24px 20px", maxWidth: 1100, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, margin: "0 0 2px" }}>{t("import.title")}</h1>
        <HelpLink guide="move-from-coolify" />
      </div>
      <p style={{ fontSize: 13, color: "var(--c-tx3)", margin: "0 0 20px" }}>{t("import.subtitle")}</p>
      <ImportWizard />
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "16px 0 0" }}>
        <Link href="/import/beszel">{t("beszelImport.title")}</Link> - {t("beszelImport.linkHint")}
      </p>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "8px 0 0" }}>
        <Link href="/migrations/objects">{t("objectMigration.title")}</Link> - {t("objectMigration.migrateObjectsHint")}
      </p>
    </div>
  );
}
