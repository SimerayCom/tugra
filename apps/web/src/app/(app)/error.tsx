"use client";

import Link from "next/link";
import { useT } from "../../i18n/provider";
import { Btn, Card } from "../../components/ui";

export default function AppError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useT();
  return (
    <div style={{ padding: "var(--page-pad)", maxWidth: 520 }}>
      <Card style={{ padding: 20 }}>
        <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>{t("errors.errorTitle")}</div>
        <p style={{ color: "var(--c-tx3)", fontSize: 14, margin: "0 0 16px" }}>{t("errors.errorDesc")}</p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Btn onClick={() => reset()}>{t("errors.retry")}</Btn>
          <Link href="/dashboard"><Btn variant="ghost">{t("errors.backHome")}</Btn></Link>
        </div>
      </Card>
    </div>
  );
}
