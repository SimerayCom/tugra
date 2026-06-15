"use client";

import { useT } from "../i18n/provider";

export function Stub({ title }: { title: string }) {
  const t = useT();
  return (
    <div style={{ padding: 32 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 6px" }}>{title}</h1>
      <p style={{ color: "var(--c-tx3)", fontSize: 14 }}>{t("common.comingSoonDesc")}</p>
    </div>
  );
}
