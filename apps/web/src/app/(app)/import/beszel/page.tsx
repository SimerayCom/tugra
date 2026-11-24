"use client";

import Link from "next/link";
import { useT } from "../../../../i18n/provider";
import { BeszelImport } from "../../../../components/beszel-import";

export default function BeszelImportPage() {
  const t = useT();
  return (
    <div style={{ padding: "24px 20px", maxWidth: 1100, margin: "0 auto" }}>
      <p style={{ fontSize: 12, margin: "0 0 8px" }}>
        <Link href="/import">{t("beszelImport.back")}</Link>
      </p>
      <h1 style={{ fontSize: 20, fontWeight: 600, margin: "0 0 2px" }}>{t("beszelImport.title")}</h1>
      <p style={{ fontSize: 13, color: "var(--c-tx3)", margin: "0 0 20px" }}>{t("beszelImport.subtitle")}</p>
      <BeszelImport />
    </div>
  );
}
