"use client";

import Link from "next/link";
import { useState } from "react";
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

export default function ForgotPasswordPage() {
  const t = useT();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    // Enumeration-safe: the endpoint always succeeds; a network error still shows the same
    // neutral confirmation so nothing about the account is revealed.
    await api.forgotPassword(email).catch(() => undefined);
    setSent(true);
    setBusy(false);
  };

  return (
    <Card style={{ padding: 24 }}>
      <h1 style={{ fontSize: 18, fontWeight: 700, margin: "0 0 16px" }}>{t("auth.forgotTitle")}</h1>
      {sent ? (
        <div style={{ fontSize: 14, color: "var(--c-tx2)", lineHeight: 1.5 }}>{t("auth.forgotSent")}</div>
      ) : (
        <form onSubmit={submit}>
          <p style={{ fontSize: 13, color: "var(--c-tx3)", margin: "0 0 14px", lineHeight: 1.5 }}>{t("auth.forgotDesc")}</p>
          <input style={field} type="email" placeholder={t("auth.email")} value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          <Btn type="submit" disabled={busy} style={{ width: "100%" }}>{busy ? "…" : t("auth.forgotSubmit")}</Btn>
        </form>
      )}
      <div style={{ marginTop: 14, fontSize: 13, color: "var(--c-tx3)", textAlign: "center" }}>
        <Link href="/login" style={{ color: "var(--c-a)" }}>{t("auth.backToLogin")}</Link>
      </div>
    </Card>
  );
}
