"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "../../../../lib/auth";
import { useT } from "../../../../i18n/provider";

/** The hub already set the httpOnly session cookies during the OAuth callback, so here we just
 * establish the session (who am I?) and redirect — no tokens ever touch the URL or JS. */
export default function OAuthCallbackPage() {
  const router = useRouter();
  const { reload } = useAuth();
  const t = useT();

  useEffect(() => {
    void reload().then(() => router.replace("/dashboard"));
  }, [reload, router]);

  return <div style={{ textAlign: "center", color: "var(--c-tx3)", fontSize: 14 }}>{t("auth.signingIn")}</div>;
}
