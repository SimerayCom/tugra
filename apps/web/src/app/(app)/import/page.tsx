"use client";

import { useT } from "../../../i18n/provider";
import { ImportWizard } from "../../../components/import-wizard";

export default function ImportPage() {
  const t = useT();
  return (
    <div style={{ padding: "24px 20px", maxWidth: 820, margin: "0 auto" }}>
      <h1 style={{ fontSize: 20, fontWeight: 600, margin: "0 0 2px" }}>{t("import.title")}</h1>
      <p style={{ fontSize: 13, color: "var(--c-tx3)", margin: "0 0 20px" }}>{t("import.subtitle")}</p>
      <ImportWizard />
    </div>
  );
}
