"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { api } from "../../../lib/api";
import { useT } from "../../../i18n/provider";
import { Btn, Card } from "../../../components/ui";

const field: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  background: "var(--c-el)",
  border: "1px solid var(--c-bd)",
  borderRadius: "var(--r1)",
  color: "var(--c-tx)",
  fontSize: 14,
  fontFamily: "inherit",
  marginBottom: 10,
};

function ResetPasswordInner() {
  const t = useT();
  const router = useRouter();
  const token = useSearchParams().get("token") ?? "";
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    if (pw.length < 8) return setErr(t("auth.passwordMin"));
    if (pw !== confirm) return setErr(t("auth.passwordMismatch"));
    setBusy(true);
    try {
      await api.resetPassword(token, pw);
      setDone(true);
      setTimeout(() => router.replace("/login"), 1800);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("auth.resetFailed"));
    }
    setBusy(false);
  };

  if (!token) {
    return (
      <Card style={{ padding: 24 }}>
        <div style={{ fontSize: 14, color: "var(--c-tx2)", marginBottom: 12 }}>{t("auth.resetNoToken")}</div>
        <Link href="/forgot-password" style={{ color: "var(--c-a)", fontSize: 13 }}>{t("auth.forgotTitle")}</Link>
      </Card>
    );
  }

  return (
    <Card style={{ padding: 24 }}>
      <h1 style={{ fontSize: 18, fontWeight: 700, margin: "0 0 16px" }}>{t("auth.resetTitle")}</h1>
      {done ? (
        <div style={{ fontSize: 14, color: "var(--c-g)", lineHeight: 1.5 }}>{t("auth.resetDone")}</div>
      ) : (
        <form onSubmit={submit}>
          <input style={field} type="password" placeholder={t("auth.newPassword")} value={pw} onChange={(e) => setPw(e.target.value)} required autoFocus />
          <input style={field} type="password" placeholder={t("auth.confirmPassword")} value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
          {err && <div style={{ color: "var(--c-r)", fontSize: 13, marginBottom: 10 }}>{err}</div>}
          <Btn type="submit" disabled={busy} style={{ width: "100%" }}>{busy ? "…" : t("auth.resetSubmit")}</Btn>
        </form>
      )}
      <div style={{ marginTop: 14, fontSize: 13, color: "var(--c-tx3)", textAlign: "center" }}>
        <Link href="/login" style={{ color: "var(--c-a)" }}>{t("auth.backToLogin")}</Link>
      </div>
    </Card>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetPasswordInner />
    </Suspense>
  );
}
