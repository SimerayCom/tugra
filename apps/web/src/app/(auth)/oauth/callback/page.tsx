"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { tokens } from "../../../../lib/api";
import { useAuth } from "../../../../lib/auth";
import { useT } from "../../../../i18n/provider";

/** Reads Tugra tokens handed back by the OAuth callback in the URL fragment,
 * persists them, then establishes the session and redirects to the dashboard. */
export default function OAuthCallbackPage() {
  const router = useRouter();
  const { reload } = useAuth();
  const t = useT();

  useEffect(() => {
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const access = hash.get("access");
    const refresh = hash.get("refresh");
    // Strip the tokens from the address bar so they aren't kept in history.
    history.replaceState(null, "", window.location.pathname);
    if (access && refresh) {
      tokens.set({ accessToken: access, refreshToken: refresh });
      void reload().then(() => router.replace("/dashboard"));
    } else {
      router.replace("/login?error=oauth");
    }
  }, [reload, router]);

  return <div style={{ textAlign: "center", color: "var(--c-tx3)", fontSize: 14 }}>{t("auth.signingIn")}</div>;
}
