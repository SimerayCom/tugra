"use client";

import Link from "next/link";
import { useT } from "../i18n/provider";
import { Btn } from "../components/ui";

export default function NotFound() {
  const t = useT();
  return (
    <div style={{ minHeight: "100dvh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14, padding: "var(--page-pad)", textAlign: "center" }}>
      <div style={{ fontSize: 48, fontWeight: 700, color: "var(--c-a)" }}>404</div>
      <div style={{ fontSize: 20, fontWeight: 600 }}>{t("errors.notFoundTitle")}</div>
      <p style={{ color: "var(--c-tx3)", fontSize: 14, margin: 0, maxWidth: 420 }}>{t("errors.notFoundDesc")}</p>
      <Link href="/dashboard"><Btn>{t("errors.backHome")}</Btn></Link>
    </div>
  );
}
