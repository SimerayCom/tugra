"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "../../../lib/auth";
import { useT } from "../../../i18n/provider";
import { Card } from "../../../components/ui";
import { CenteredSpinner } from "../../../components/shell";
import { TwoFactorEnroll } from "../../../components/two-factor";

/**
 * Where an owner/admin lands when the instance requires 2FA and they haven't enrolled. The hub confines such a
 * session to account self-service, so this page (and /auth/2fa/*) is the one way forward; it is never a dead end.
 */
export default function TwoFactorSetupPage() {
  const t = useT();
  const router = useRouter();
  const { user, loading, logout } = useAuth();
  const home = user?.uiMode === "home" ? "/home" : "/dashboard";

  useEffect(() => {
    if (loading) return;
    if (!user) router.replace("/login");
    else if (!user.twoFaSetupRequired) router.replace(home);
  }, [loading, user, home, router]);

  if (loading || !user || !user.twoFaSetupRequired) return <CenteredSpinner />;

  return (
    <Card style={{ padding: 24 }}>
      <h1 style={{ fontSize: 18, fontWeight: 700, margin: "0 0 6px" }}>{t("auth.twoFaRequiredTitle")}</h1>
      <p style={{ fontSize: 14, color: "var(--c-tx2)", margin: "0 0 16px" }}>{t("auth.twoFaRequiredBody")}</p>
      <TwoFactorEnroll onEnrolled={() => router.replace(home)} />
      <div style={{ marginTop: 16, textAlign: "center" }}>
        <button
          type="button"
          onClick={async () => {
            await logout();
            router.replace("/login");
          }}
          style={{ background: "none", border: "none", color: "var(--c-tx3)", fontSize: 13, cursor: "pointer" }}
        >
          {t("auth.twoFaRequiredLogout")}
        </button>
      </div>
    </Card>
  );
}
