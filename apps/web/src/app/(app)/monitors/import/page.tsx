"use client";

import { useT } from "../../../../i18n/provider";
import { PageHeader } from "../../../../components/page-header";
import { KumaImport } from "../../../../components/kuma-import";

export default function KumaImportPage() {
  const t = useT();
  return (
    <div style={{ padding: "var(--page-pad)", maxWidth: 820 }}>
      <PageHeader
        breadcrumb={[{ label: t("nav.uptime"), href: "/monitors" }, { label: t("monitors.kuma.title") }]}
        title={t("monitors.kuma.title")}
      >
        <p style={{ color: "var(--c-tx3)", fontSize: 13, margin: 0 }}>{t("monitors.kuma.subtitle")}</p>
      </PageHeader>
      <KumaImport />
    </div>
  );
}
