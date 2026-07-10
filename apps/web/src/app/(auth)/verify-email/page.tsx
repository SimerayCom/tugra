"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { api } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { useT } from "../../../i18n/provider";
import { Card } from "../../../components/ui";

function VerifyEmailInner() {
  const t = useT();
  const { reload, user } = useAuth();
  const token = useSearchParams().get("token") ?? "";
  const [status, setStatus] = useState<"pending" | "success" | "failed">("pending");
  const ran = useRef(false);

  useEffect(() => {
    if (!token || ran.current) return;
    ran.current = true; // verify exactly once (a token is single-use)
    api
      .verifyEmail(token)
      .then(() => reload().catch(() => undefined)) // refresh the session's emailVerified if logged in
      .then(() => setStatus("success"))
      .catch(() => setStatus("failed"));
  }, [token, reload]);

  const body = !token
    ? { color: "var(--c-tx2)", text: t("auth.verifyNoToken") }
    : status === "pending"
      ? { color: "var(--c-tx3)", text: t("auth.verifyPending") }
      : status === "success"
        ? { color: "var(--c-g)", text: t("auth.verifySuccess") }
        : { color: "var(--c-r)", text: t("auth.verifyFailed") };

  return (
    <Card style={{ padding: 24 }}>
      <h1 style={{ fontSize: 18, fontWeight: 700, margin: "0 0 16px" }}>{t("auth.verifyTitle")}</h1>
      <div style={{ fontSize: 14, color: body.color, lineHeight: 1.5 }}>{body.text}</div>
      <div style={{ marginTop: 16, fontSize: 13, color: "var(--c-tx3)", textAlign: "center" }}>
        {/* Only offer the dashboard when there's actually a session — a cross-device / logged-out
            verify has no session, so the guarded dashboard would just bounce them to sign-in. */}
        {status === "success" && user ? (
          <Link href="/dashboard" style={{ color: "var(--c-a)" }}>{t("auth.verifyGoDashboard")}</Link>
        ) : (
          <Link href="/login" style={{ color: "var(--c-a)" }}>{t("auth.backToLogin")}</Link>
        )}
      </div>
    </Card>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense>
      <VerifyEmailInner />
    </Suspense>
  );
}
