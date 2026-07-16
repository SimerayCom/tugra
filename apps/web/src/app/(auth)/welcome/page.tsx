"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAuth } from "../../../lib/auth";
import { useT } from "../../../i18n/provider";
import { Btn, Card } from "../../../components/ui";
import { CenteredSpinner } from "../../../components/shell";

/**
 * First-run landing for a fresh install (no owner account yet). The (app) layout and /login route send an
 * uninitialized visitor here; this page funnels them to registration where the first account becomes the
 * instance owner. Loop-safe: once setup is done (initialized === true) it bounces to /login, and a
 * logged-in visitor goes straight to the dashboard.
 */
export default function WelcomePage() {
  const router = useRouter();
  const { user, loading, initialized } = useAuth();
  const t = useT();

  useEffect(() => {
    if (loading) return;
    if (user) router.replace("/dashboard");
    else if (initialized === true) router.replace("/login");
  }, [loading, user, initialized, router]);

  // Only render the welcome card once we know this is genuinely a fresh, logged-out install.
  if (loading || user || initialized !== false) return <CenteredSpinner />;

  return (
    <Card style={{ padding: 24, textAlign: "center" }}>
      <h1 style={{ fontSize: 20, fontWeight: 700, margin: "0 0 8px" }}>{t("auth.welcomeTitle")}</h1>
      <p style={{ fontSize: 14, color: "var(--c-tx3)", margin: "0 0 20px", lineHeight: 1.5 }}>
        {t("auth.welcomeBody")}
      </p>
      <Btn onClick={() => router.push("/register")} style={{ width: "100%" }}>
        {t("auth.welcomeCta")}
      </Btn>
    </Card>
  );
}
