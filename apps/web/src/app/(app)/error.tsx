"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useT } from "../../i18n/provider";
import { Btn, Card } from "../../components/ui";
import { isStaleBuildError, reloadForNewBuild } from "../../lib/stale-build";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useT();
  const stale = isStaleBuildError(error);
  useEffect(() => {
    console.error(error);
    // The tab still runs the build from before a hub update: load the new one instead of showing an error.
    if (stale) reloadForNewBuild();
  }, [error, stale]);
  return (
    <div style={{ padding: "var(--page-pad)", maxWidth: 520 }}>
      <Card style={{ padding: 20 }}>
        <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>{t(stale ? "errors.newVersionTitle" : "errors.errorTitle")}</div>
        <p style={{ color: "var(--c-tx3)", fontSize: 14, margin: "0 0 16px" }}>{t(stale ? "errors.newVersionDesc" : "errors.errorDesc")}</p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Btn onClick={() => (stale ? window.location.reload() : reset())}>{t(stale ? "errors.reload" : "errors.retry")}</Btn>
          <Link href="/dashboard"><Btn variant="ghost">{t("errors.backHome")}</Btn></Link>
        </div>
      </Card>
    </div>
  );
}
